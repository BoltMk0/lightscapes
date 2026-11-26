import type { Layer, LayerClock, LightId, LightInfo, LightState, Program, Scene, Timeline } from "../../src/protocol/index.ts";
import { hexToKelvin, kelvinToHex, timelineAt } from "../../src/color/index.ts";
import type { Adapter, ResolvedState } from "./adapters/adapter.ts";

/** The shortest fade between timeline steps, so a stop just ahead doesn't make a burst of them. */
const MIN_STEP_MS = 500;
/** The dimmest a light following a timeline is sent, so a scaled-down colour doesn't turn it off. */
const MIN_BRIGHTNESS = 1 / 254;

export const EMPTY_PROGRAM: Program = { scenes: {}, timelines: {}, fadeSeconds: 2 };

type Cue = { layer: Layer; startAt: number; endAt: number | null };

/** What a light was last set to, and by which layer. */
type Applied = {
    layerId: string | null;
    /** How long to fade back when its layer (a cue) is gone. */
    returnFade?: number;
    /** What it was last sent, as JSON, so the same isn't sent again. */
    sent: string | null;
    /** The timeline group it's moving along with, if it is. */
    following: string | null;
};

type TimelineGroup = {
    key: string;
    timeline: Timeline;
    clock: LayerClock | undefined;
    targets: { id: LightId; scale: number; fade: number }[];
};

export type TimeSource = { now(): number };

/** Where a layer's clock is, at `t` (in the app's time): 0-1. */
export function clockPosition(clock: LayerClock | undefined, t: number): number {
    if(!clock) return 0;
    if(clock.kind === 'fixed') return clock.position;
    if(clock.durationMs <= 0) return 1;
    const p = Math.min(1, Math.max(0, (t - clock.startedAt) / clock.durationMs));
    return p >= 1 || clock.cap === undefined ? p : Math.min(p, clock.cap);
}

/** A state as a light can show it: a white as its colour on a light that only does colours, and the other way about. */
export function fitToLight(state: ResolvedState, info: LightInfo | undefined): ResolvedState {
    if(!info || !state.color) return state;
    const { caps } = info;
    if(state.color.kind === 'white' && !caps.white && caps.color) return { ...state, color: { kind: 'rgb', hex: kelvinToHex(state.color.kelvin) } };
    if(state.color.kind === 'rgb' && !caps.color && caps.white){
        const kelvin = Math.min(caps.white.maxKelvin, Math.max(caps.white.minKelvin, hexToKelvin(state.color.hex)));
        return { ...state, color: { kind: 'white', kelvin } };
    }
    return state;
}

/**
 * Keeps the lights showing what the app's layers and cues say. For each light, the highest-priority layer that names it
 * wins (a later cue over an earlier one at the same priority); lights no layer names are left as they are. Lights
 * following a timeline are moved along it as their layer's clock runs.
 */
export class Renderer {
    #adapters: Adapter[];
    #time: TimeSource;
    #log: (text: string) => void;

    #program: Program = EMPTY_PROGRAM;
    #layers: Layer[] = [];
    #cues = new Map<string, Cue>();
    #applied = new Map<LightId, Applied>();
    #groups = new Map<string, TimelineGroup>();
    #timelineTimers = new Map<string, ReturnType<typeof setTimeout>>();
    #wakeTimer: ReturnType<typeof setTimeout> | null = null;
    /** What the layers showed, for the activity log. */
    #shown = '';

    constructor(adapters: Adapter[], time: TimeSource, log: (text: string) => void) {
        this.#adapters = adapters;
        this.#time = time;
        this.#log = log;
    }

    get program(): Program { return this.#program; }
    get layers(): readonly Layer[] { return this.#layers; }

    /** Everything at once, from the app (on every connect): the lights are all set again. */
    assign(program: Program, layers: Layer[]) {
        this.#program = program;
        this.#layers = layers;
        this.#cues.clear();
        this.reset();
    }

    setProgram(program: Program) {
        this.#program = program;
        this.render();
    }

    setLayers(layers: Layer[]) {
        this.#layers = layers;
        this.render();
    }

    cue(layer: Layer, at?: number) {
        const startAt = at ?? this.#time.now();
        const endAt = layer.holdSeconds !== undefined
            ? startAt + ((layer.fadeSeconds ?? this.#program.fadeSeconds) + layer.holdSeconds) * 1000
            : layer.expiresAt ?? null;
        this.#cues.set(layer.id, { layer, startAt, endAt });
        this.render();
    }

    endCue(id: string) {
        if(this.#cues.delete(id)) this.render();
    }

    /** Forgets what the lights were sent, so they're all set again (e.g. the hardware was away and may have changed). */
    reset() {
        this.#applied.clear();
        this.render();
    }

    stop() {
        this.#clearTimers();
    }

    #clearTimers() {
        for(const timer of this.#timelineTimers.values()) clearTimeout(timer);
        this.#timelineTimers.clear();
        if(this.#wakeTimer !== null) clearTimeout(this.#wakeTimer);
        this.#wakeTimer = null;
    }

    #light(id: LightId): LightInfo | undefined {
        for(const adapter of this.#adapters){
            if(id.startsWith(adapter.id + ':')) return adapter.lights().find(l => l.id === id);
        }
        return undefined;
    }

    #send(id: LightId, state: ResolvedState, fade: number) {
        const adapter = this.#adapters.find(a => id.startsWith(a.id + ':'));
        adapter?.set(id, state, Math.max(0, fade));
    }

    #scene(layer: Layer): Scene {
        return typeof layer.scene === 'string' ? this.#program.scenes[layer.scene] ?? { entries: [] } : layer.scene;
    }

    /** Puts the lights in step with the layers and cues, sending only what's changed. */
    render() {
        this.#clearTimers();
        const now = this.#time.now();

        // Expired layers and cues go: their lights go back to what's under them
        const live = this.#layers.filter(l => l.expiresAt === undefined || l.expiresAt > now);
        if(live.length !== this.#layers.length) this.#layers = live;
        for(const [id, cue] of this.#cues) if(cue.endAt !== null && cue.endAt <= now) this.#cues.delete(id);

        const started = [...this.#cues.values()].filter(c => c.startAt <= now);
        const active = [
            ...this.#layers.map((layer, order) => ({ layer, order })),
            ...started.map((c, i) => ({ layer: c.layer, order: this.#layers.length + i }))
        ].sort((a, b) => b.layer.priority - a.layer.priority || b.order - a.order).map(a => a.layer);
        this.#logShown(active);

        const claims = new Map<LightId, { layer: Layer; light: LightState }>();
        for(const layer of active){
            for(const entry of this.#scene(layer).entries){
                if(!claims.has(entry.target)) claims.set(entry.target, { layer, light: entry.light });
            }
        }

        const groups = new Map<string, TimelineGroup>();
        for(const [id, { layer, light }] of claims){
            const previous = this.#applied.get(id);
            const changedLayer = previous?.layerId !== layer.id;
            // Back from a cue at the cue's fade; otherwise at this layer's
            const fade = changedLayer && previous?.returnFade !== undefined ? previous.returnFade : layer.fadeSeconds ?? this.#program.fadeSeconds;
            const returnFade = layer.holdSeconds !== undefined ? layer.fadeSeconds ?? this.#program.fadeSeconds : undefined;

            if(light.on && light.color?.kind === 'timeline'){
                const timeline = this.#program.timelines[light.color.id];
                if(timeline){
                    const key = `${layer.id}|${light.color.id}|${JSON.stringify(layer.clock ?? null)}`;
                    let group = groups.get(key);
                    if(!group){
                        group = { key, timeline, clock: layer.clock, targets: [] };
                        groups.set(key, group);
                    }
                    group.targets.push({ id, scale: light.brightness ?? 1, fade });
                    this.#applied.set(id, { layerId: layer.id, returnFade, sent: previous?.sent ?? null, following: previous?.following === key ? key : null });
                    continue;
                }
            }

            const resolved = fitToLight({
                on: light.on,
                ...(light.brightness !== undefined ? { brightness: light.brightness } : {}),
                ...(light.color && light.color.kind !== 'timeline' ? { color: light.color } : {}),
                ...(light.effect ? { effect: light.effect } : {})
            }, this.#light(id));
            const sent = JSON.stringify(resolved);
            if(sent !== previous?.sent || (changedLayer && resolved.effect)) this.#send(id, resolved, fade);
            this.#applied.set(id, { layerId: layer.id, returnFade, sent, following: null });
        }

        // Lights no layer names now are left as they are, and remembered as such
        for(const [id, applied] of this.#applied){
            if(!claims.has(id)) this.#applied.set(id, { ...applied, layerId: null, returnFade: undefined, following: null });
        }

        this.#groups = groups;
        for(const group of groups.values()) this.#step(group);
        this.#scheduleWake(now);
    }

    /** Moves a timeline's lights along: to where it is, for lights just joining it; to where it'll be, for the rest. */
    #step(group: TimelineGroup) {
        const now = this.#time.now();
        const { clock, timeline } = group;
        const running = clock?.kind === 'running';
        const end = running ? (clock.cap ?? 1) : 1;
        const moving = running && clockPosition(clock, now) < end;

        // Each colour is the one due at the end of its fade, so the lights arrive with it rather than after it; and a
        // fade ends on any stop before then, so a short-lived colour isn't stepped over
        let target = now;
        if(moving){
            target = now + timeline.stepSeconds * 1000;
            for(const stop of timeline.stops){
                const at = clock.startedAt + Math.min(stop.at, end) * clock.durationMs;
                if(at > now + MIN_STEP_MS && at < target){
                    target = at;
                    break;
                }
            }
        }
        const nowPoint = timelineAt(timeline.stops, clockPosition(clock, now));
        const aheadPoint = timelineAt(timeline.stops, clockPosition(clock, target));

        let continuing = false;
        for(const t of group.targets){
            const applied = this.#applied.get(t.id)!;
            const joined = applied.following !== group.key;
            continuing ||= !joined;
            const point = joined || !moving ? nowPoint : aheadPoint;
            const fade = joined ? t.fade : moving ? (target - now) / 1000 : t.fade;
            const resolved = fitToLight({ on: true, color: point.color, brightness: Math.max(MIN_BRIGHTNESS, point.brightness * t.scale) }, this.#light(t.id));
            const sent = JSON.stringify(resolved);
            if(sent !== applied.sent) this.#send(t.id, resolved, fade);
            this.#applied.set(t.id, { ...applied, sent, following: group.key });
        }

        if(moving){
            const delay = continuing ? target - now : Math.max(Math.max(...group.targets.map(t => t.fade)) * 1000, MIN_STEP_MS);
            this.#timelineTimers.set(group.key, setTimeout(() => {
                this.#timelineTimers.delete(group.key);
                const current = this.#groups.get(group.key);
                if(current) this.#step(current);
            }, delay));
        }
    }

    /** Wakes when a cue starts or ends, or a layer expires. */
    #scheduleWake(now: number) {
        const times = [
            ...[...this.#cues.values()].flatMap(c => [c.startAt, c.endAt]),
            ...this.#layers.map(l => l.expiresAt)
        ].filter((t): t is number => t !== null && t !== undefined && t > now);
        if(times.length === 0) return;
        this.#wakeTimer = setTimeout(() => {
            this.#wakeTimer = null;
            this.render();
        }, Math.min(...times) - now);
    }

    #logShown(active: Layer[]) {
        const shown = active.map(l => `${l.id}${typeof l.scene === 'string' ? `: ${l.scene}` : ''}`).join(', ');
        if(shown !== this.#shown){
            this.#shown = shown;
            this.#log(shown ? `Showing ${shown}` : 'Nothing to show: the lights are left as they are');
        }
    }
}
