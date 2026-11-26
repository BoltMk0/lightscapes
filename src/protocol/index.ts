// The messages between a Lightscapes hub and an app that drives it (such as Clockmaker), with checks for each.
//
// The hub always opens the connection. Everything it knows about the app's world is what the app sends: a program
// (named scenes and timelines) and a stack of layers saying which apply now. The hub turns those into device
// commands, and reports its lights, their states and button presses back.

/** Bumped when a message changes in a way an older hub or app would misread. New optional fields don't bump it. */
export const PROTOCOL_VERSION = 1;

// --- Values ----------------------------------------------------------------------------------------------------------

/** A light or group, namespaced by the adapter it's on, e.g. "z2m:table-lamp". */
export type LightId = string;

export type RgbColor = { kind: 'rgb'; hex: string };
export type WhiteColor = { kind: 'white'; kelvin: number };
/** Follows a timeline of the program, at the clock of the layer it's in. */
export type TimelineRef = { kind: 'timeline'; id: string };
export type Color = RgbColor | WhiteColor | TimelineRef;
export type TimelineColor = RgbColor | WhiteColor;

/** What a light is set to. Anything left out is left as it is. */
export type LightState = {
    on: boolean;
    /** 0-1. On a light following a timeline, it scales the timeline's brightness instead (1, or left out, for as it is). */
    brightness?: number;
    color?: Color;
    /** An effect the light plays by itself (e.g. "blink", "breathe"), played after the rest is set. */
    effect?: string;
};

export type SceneEntry = { target: LightId; light: LightState };
export type Scene = { entries: SceneEntry[] };

export type TimelineStop = {
    /** How far along, 0-1. */
    at: number;
    color: TimelineColor;
    /** 0-1 */
    brightness: number;
};

/** Colours that lights fade through as a layer's clock runs. */
export type Timeline = {
    stops: TimelineStop[];
    /** How often lights following it are sent their next colour; they fade smoothly in between. */
    stepSeconds: number;
};

export type Program = {
    scenes: Record<string, Scene>;
    timelines: Record<string, Timeline>;
    /** How long lights take to change to a new layer's, unless the layer says otherwise. */
    fadeSeconds: number;
};

/** How far along its timelines a layer is: running from a start time (in the app's time), or fixed. */
export type LayerClock =
    | { kind: 'running'; startedAt: number; durationMs: number; /** Stops short of this until the time's up, 0-1. */ cap?: number }
    | { kind: 'fixed'; position: number };

/**
 * A layer of what the lights show. For each light, the highest-priority layer that names it wins; a light no layer
 * names is left as it is.
 */
export type Layer = {
    id: string;
    priority: number;
    /** A program scene by name, or one given here. */
    scene: string | Scene;
    clock?: LayerClock;
    /** How long its lights take to change to it, and (for a cue) back from it. */
    fadeSeconds?: number;
    /** A cue: once faded in, held this long, then it removes itself and the lights fade back. */
    holdSeconds?: number;
    /** When it removes itself, in the app's time. */
    expiresAt?: number;
};

export type AdapterHealth = { id: string; name: string; ok: boolean; detail?: string };

export type LightCaps = {
    brightness: boolean;
    color: boolean;
    /** The whites it does, if it does whites. */
    white?: { minKelvin: number; maxKelvin: number };
    effects: string[];
};

export type LightInfo = {
    id: LightId;
    name: string;
    kind: 'device' | 'group';
    /** A group's lights. */
    members?: LightId[];
    caps: LightCaps;
    /** What it is, e.g. its model, for showing. */
    description?: string;
};

export type InputInfo = {
    id: string;
    name: string;
    /** The actions it sends (e.g. single, double, hold), or null if it doesn't say. */
    actions: string[] | null;
    description?: string;
};

/** A light's state as the hub knows it. */
export type ReportedState = {
    on: boolean | null;
    brightness?: number;
    color?: TimelineColor;
    /** Whether it answers, or null if that isn't known. */
    reachable: boolean | null;
    /** Reported by the light itself, or assumed (e.g. a group's, or what it was last sent). */
    source: 'reported' | 'assumed';
};

export type Activity = { at: number; text: string };

// --- Hub to app ------------------------------------------------------------------------------------------------------

/** Opens every connection, as its body. */
export type HelloMessage = {
    type: 'hello';
    hubId: string;
    name: string;
    hubVersion: string;
    protocol: number;
    adapters: AdapterHealth[];
};
export type InventoryMessage = { type: 'inventory'; lights: LightInfo[]; inputs: InputInfo[] };
/** Every light's state. */
export type StatesMessage = { type: 'states'; states: Record<LightId, ReportedState> };
/** One light's state changed. */
export type StateMessage = { type: 'state'; id: LightId; state: ReportedState };
export type InputMessage = { type: 'input'; device: string; action: string; value?: number; at: number };
export type StatusMessage = { type: 'status'; adapters: AdapterHealth[]; activity: Activity[] };
/** Settings a hub had before it was driven by an app, for the app to import. */
export type LegacyConfigMessage = { type: 'legacyConfig'; config: unknown };

export type HubMessage =
    | InventoryMessage
    | StatesMessage
    | StateMessage
    | InputMessage
    | StatusMessage
    | LegacyConfigMessage;

// --- App to hub ------------------------------------------------------------------------------------------------------

export type WelcomeMessage = {
    type: 'welcome';
    result: 'accepted' | 'pending' | 'rejected';
    protocol: number;
    /** Why, if it's rejected. */
    reason?: string;
};
/** Everything the hub needs, sent whenever it's accepted (and so on every reconnect). */
export type AssignMessage = {
    type: 'assign';
    /** What the hub is following, for showing on its page, or null for nothing. */
    following: { id: string; name: string } | null;
    program: Program;
    layers: Layer[];
};
export type ProgramMessage = { type: 'program'; program: Program };
/** Replaces the layers (not the cues). */
export type LayersMessage = { type: 'layers'; layers: Layer[] };
/** Adds a layer at `at` (in the app's time; now if left out), alongside the layers, until it removes itself. */
export type CueMessage = { type: 'cue'; layer: Layer; at?: number };
export type EndCueMessage = { type: 'endCue'; id: string };
/** The app's time now, sent every few seconds. */
export type SyncMessage = { type: 'sync'; serverTime: number };
/** Asks for every light's state again, fresh from the lights where the adapter can. */
export type GetStatesMessage = { type: 'getStates' };

export type AppMessage =
    | WelcomeMessage
    | AssignMessage
    | ProgramMessage
    | LayersMessage
    | CueMessage
    | EndCueMessage
    | SyncMessage
    | GetStatesMessage;

// --- Checks ----------------------------------------------------------------------------------------------------------

export class ProtocolError extends Error {}

function fail(path: string, message: string): never {
    throw new ProtocolError(`${path}: ${message}`);
}

function obj(value: unknown, path: string): Record<string, unknown> {
    if(typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'should be an object');
    return value as Record<string, unknown>;
}

function str(value: unknown, path: string, { empty = false } = {}): string {
    if(typeof value !== 'string') fail(path, 'should be text');
    if(!empty && value === '') fail(path, 'should not be empty');
    return value;
}

function num(value: unknown, path: string, min = -Infinity, max = Infinity): number {
    if(typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'should be a number');
    if(value < min || value > max) fail(path, `should be between ${min} and ${max}`);
    return value;
}

function bool(value: unknown, path: string): boolean {
    if(typeof value !== 'boolean') fail(path, 'should be true or false');
    return value;
}

function arr<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
    if(!Array.isArray(value)) fail(path, 'should be a list');
    return value.map((v, i) => item(v, `${path}[${i}]`));
}

function record<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): Record<string, T> {
    const o = obj(value, path);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, item(v, `${path}.${k}`)]));
}

function opt<T>(value: unknown, check: (value: unknown) => T): T | undefined {
    return value === undefined ? undefined : check(value);
}

const HEX = /^#[0-9a-f]{6}$/i;

function hex(value: unknown, path: string): string {
    const text = str(value, path);
    if(!HEX.test(text)) fail(path, 'should be a colour like #ffaa00');
    return text.toLowerCase();
}

export function checkTimelineColor(value: unknown, path = 'color'): TimelineColor {
    const o = obj(value, path);
    if(o.kind === 'rgb') return { kind: 'rgb', hex: hex(o.hex, `${path}.hex`) };
    if(o.kind === 'white') return { kind: 'white', kelvin: num(o.kelvin, `${path}.kelvin`, 1000, 20000) };
    fail(`${path}.kind`, 'should be rgb or white');
}

export function checkColor(value: unknown, path = 'color'): Color {
    const o = obj(value, path);
    if(o.kind === 'timeline') return { kind: 'timeline', id: str(o.id, `${path}.id`) };
    return checkTimelineColor(o, path);
}

export function checkLightState(value: unknown, path = 'light'): LightState {
    const o = obj(value, path);
    const light: LightState = { on: bool(o.on, `${path}.on`) };
    const brightness = opt(o.brightness, v => num(v, `${path}.brightness`, 0, 1));
    if(brightness !== undefined) light.brightness = brightness;
    const color = opt(o.color, v => checkColor(v, `${path}.color`));
    if(color !== undefined) light.color = color;
    const effect = opt(o.effect, v => str(v, `${path}.effect`));
    if(effect !== undefined) light.effect = effect;
    return light;
}

export function checkScene(value: unknown, path = 'scene'): Scene {
    const o = obj(value, path);
    return {
        entries: arr(o.entries, `${path}.entries`, (e, p) => {
            const entry = obj(e, p);
            return { target: str(entry.target, `${p}.target`), light: checkLightState(entry.light, `${p}.light`) };
        })
    };
}

export function checkTimeline(value: unknown, path = 'timeline'): Timeline {
    const o = obj(value, path);
    const stops = arr(o.stops, `${path}.stops`, (s, p) => {
        const stop = obj(s, p);
        return {
            at: num(stop.at, `${p}.at`, 0, 1),
            color: checkTimelineColor(stop.color, `${p}.color`),
            brightness: num(stop.brightness, `${p}.brightness`, 0, 1)
        };
    }).sort((a, b) => a.at - b.at);
    if(stops.length === 0) fail(`${path}.stops`, 'should have at least one stop');
    return { stops, stepSeconds: num(o.stepSeconds, `${path}.stepSeconds`, 0.5, 600) };
}

export function checkProgram(value: unknown, path = 'program'): Program {
    const o = obj(value, path);
    return {
        scenes: record(o.scenes, `${path}.scenes`, checkScene),
        timelines: record(o.timelines, `${path}.timelines`, checkTimeline),
        fadeSeconds: num(o.fadeSeconds, `${path}.fadeSeconds`, 0, 600)
    };
}

function checkClock(value: unknown, path: string): LayerClock {
    const o = obj(value, path);
    if(o.kind === 'running'){
        const clock: LayerClock = {
            kind: 'running',
            startedAt: num(o.startedAt, `${path}.startedAt`),
            durationMs: num(o.durationMs, `${path}.durationMs`, 0)
        };
        const cap = opt(o.cap, v => num(v, `${path}.cap`, 0, 1));
        if(cap !== undefined) clock.cap = cap;
        return clock;
    }
    if(o.kind === 'fixed') return { kind: 'fixed', position: num(o.position, `${path}.position`, 0, 1) };
    fail(`${path}.kind`, 'should be running or fixed');
}

export function checkLayer(value: unknown, path = 'layer'): Layer {
    const o = obj(value, path);
    const layer: Layer = {
        id: str(o.id, `${path}.id`),
        priority: num(o.priority, `${path}.priority`),
        scene: typeof o.scene === 'string' ? str(o.scene, `${path}.scene`) : checkScene(o.scene, `${path}.scene`)
    };
    const clock = opt(o.clock, v => checkClock(v, `${path}.clock`));
    if(clock) layer.clock = clock;
    const fadeSeconds = opt(o.fadeSeconds, v => num(v, `${path}.fadeSeconds`, 0, 600));
    if(fadeSeconds !== undefined) layer.fadeSeconds = fadeSeconds;
    const holdSeconds = opt(o.holdSeconds, v => num(v, `${path}.holdSeconds`, 0, 86400));
    if(holdSeconds !== undefined) layer.holdSeconds = holdSeconds;
    const expiresAt = opt(o.expiresAt, v => num(v, `${path}.expiresAt`));
    if(expiresAt !== undefined) layer.expiresAt = expiresAt;
    return layer;
}

function checkAdapterHealth(value: unknown, path: string): AdapterHealth {
    const o = obj(value, path);
    const health: AdapterHealth = { id: str(o.id, `${path}.id`), name: str(o.name, `${path}.name`), ok: bool(o.ok, `${path}.ok`) };
    const detail = opt(o.detail, v => str(v, `${path}.detail`, { empty: true }));
    if(detail !== undefined) health.detail = detail;
    return health;
}

function checkLightInfo(value: unknown, path: string): LightInfo {
    const o = obj(value, path);
    if(o.kind !== 'device' && o.kind !== 'group') fail(`${path}.kind`, 'should be device or group');
    const caps = obj(o.caps, `${path}.caps`);
    const info: LightInfo = {
        id: str(o.id, `${path}.id`),
        name: str(o.name, `${path}.name`),
        kind: o.kind,
        caps: {
            brightness: bool(caps.brightness, `${path}.caps.brightness`),
            color: bool(caps.color, `${path}.caps.color`),
            effects: arr(caps.effects, `${path}.caps.effects`, str)
        }
    };
    if(caps.white !== undefined){
        const white = obj(caps.white, `${path}.caps.white`);
        info.caps.white = {
            minKelvin: num(white.minKelvin, `${path}.caps.white.minKelvin`, 0),
            maxKelvin: num(white.maxKelvin, `${path}.caps.white.maxKelvin`, 0)
        };
    }
    const members = opt(o.members, v => arr(v, `${path}.members`, str));
    if(members) info.members = members;
    const description = opt(o.description, v => str(v, `${path}.description`, { empty: true }));
    if(description !== undefined) info.description = description;
    return info;
}

function checkInputInfo(value: unknown, path: string): InputInfo {
    const o = obj(value, path);
    const info: InputInfo = {
        id: str(o.id, `${path}.id`),
        name: str(o.name, `${path}.name`),
        actions: o.actions === null ? null : arr(o.actions, `${path}.actions`, str)
    };
    const description = opt(o.description, v => str(v, `${path}.description`, { empty: true }));
    if(description !== undefined) info.description = description;
    return info;
}

function checkReportedState(value: unknown, path: string): ReportedState {
    const o = obj(value, path);
    if(o.source !== 'reported' && o.source !== 'assumed') fail(`${path}.source`, 'should be reported or assumed');
    const state: ReportedState = {
        on: o.on === null ? null : bool(o.on, `${path}.on`),
        reachable: o.reachable === null ? null : bool(o.reachable, `${path}.reachable`),
        source: o.source
    };
    const brightness = opt(o.brightness, v => num(v, `${path}.brightness`, 0, 1));
    if(brightness !== undefined) state.brightness = brightness;
    const color = opt(o.color, v => checkTimelineColor(v, `${path}.color`));
    if(color) state.color = color;
    return state;
}

function checkActivity(value: unknown, path: string): Activity {
    const o = obj(value, path);
    return { at: num(o.at, `${path}.at`), text: str(o.text, `${path}.text`, { empty: true }) };
}

export function checkHello(value: unknown): HelloMessage {
    const o = obj(value, 'hello');
    if(o.type !== 'hello') fail('hello.type', 'should be hello');
    return {
        type: 'hello',
        hubId: str(o.hubId, 'hello.hubId'),
        name: str(o.name, 'hello.name'),
        hubVersion: str(o.hubVersion, 'hello.hubVersion'),
        protocol: num(o.protocol, 'hello.protocol', 1),
        adapters: arr(o.adapters, 'hello.adapters', checkAdapterHealth)
    };
}

/** Checks a message from a hub. Throws a ProtocolError saying what's wrong. */
export function checkHubMessage(value: unknown): HubMessage {
    const o = obj(value, 'message');
    switch(o.type){
        case 'inventory':
            return { type: 'inventory', lights: arr(o.lights, 'lights', checkLightInfo), inputs: arr(o.inputs, 'inputs', checkInputInfo) };
        case 'states':
            return { type: 'states', states: record(o.states, 'states', checkReportedState) };
        case 'state':
            return { type: 'state', id: str(o.id, 'id'), state: checkReportedState(o.state, 'state') };
        case 'input': {
            const message: InputMessage = { type: 'input', device: str(o.device, 'device'), action: str(o.action, 'action'), at: num(o.at, 'at') };
            const v = opt(o.value, x => num(x, 'value'));
            if(v !== undefined) message.value = v;
            return message;
        }
        case 'status':
            return { type: 'status', adapters: arr(o.adapters, 'adapters', checkAdapterHealth), activity: arr(o.activity, 'activity', checkActivity) };
        case 'legacyConfig':
            return { type: 'legacyConfig', config: o.config };
        default:
            fail('message.type', `unknown message type ${JSON.stringify(o.type)}`);
    }
}

/** Checks a message from an app. Throws a ProtocolError saying what's wrong. */
export function checkAppMessage(value: unknown): AppMessage {
    const o = obj(value, 'message');
    switch(o.type){
        case 'welcome': {
            if(o.result !== 'accepted' && o.result !== 'pending' && o.result !== 'rejected') fail('result', 'should be accepted, pending or rejected');
            const message: WelcomeMessage = { type: 'welcome', result: o.result, protocol: num(o.protocol, 'protocol', 1) };
            const reason = opt(o.reason, v => str(v, 'reason', { empty: true }));
            if(reason !== undefined) message.reason = reason;
            return message;
        }
        case 'assign': {
            let following: AssignMessage['following'] = null;
            if(o.following !== null){
                const f = obj(o.following, 'following');
                following = { id: str(f.id, 'following.id'), name: str(f.name, 'following.name', { empty: true }) };
            }
            return { type: 'assign', following, program: checkProgram(o.program), layers: arr(o.layers, 'layers', checkLayer) };
        }
        case 'program':
            return { type: 'program', program: checkProgram(o.program) };
        case 'layers':
            return { type: 'layers', layers: arr(o.layers, 'layers', checkLayer) };
        case 'cue': {
            const message: CueMessage = { type: 'cue', layer: checkLayer(o.layer) };
            const at = opt(o.at, v => num(v, 'at'));
            if(at !== undefined) message.at = at;
            return message;
        }
        case 'endCue':
            return { type: 'endCue', id: str(o.id, 'id') };
        case 'sync':
            return { type: 'sync', serverTime: num(o.serverTime, 'serverTime') };
        case 'getStates':
            return { type: 'getStates' };
        default:
            fail('message.type', `unknown message type ${JSON.stringify(o.type)}`);
    }
}

// --- Transport -------------------------------------------------------------------------------------------------------
//
// Over HTTP, at the one URL the hub is pointed at (e.g. https://clockmaker.example/lightscapes):
//   POST <url>/connect   body: HelloMessage   → an event stream of AppMessages, one per `data:` event
//   POST <url>/messages  body: { messages: HubMessage[] }   → 204
// Both carry `Authorization: Bearer <hubId>.<secret>`. A hub whose stream closes reconnects with backoff, and the app
// sends `sync` often enough (every few seconds) that a quiet stream can be taken as dead.

/** The longest an app goes without sending anything on a hub's stream. */
export const SYNC_INTERVAL_MS = 2000;
/** A stream quiet for this long has gone dead without closing. */
export const STREAM_TIMEOUT_MS = 6000;

export function authorizationHeader(hubId: string, secret: string): string {
    return `Bearer ${hubId}.${secret}`;
}

/** The hub id and secret from an Authorization header, if it has them. */
export function parseAuthorization(header: string | null | undefined): { hubId: string; secret: string } | null {
    const match = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header ?? '');
    return match ? { hubId: match[1], secret: match[2] } : null;
}
