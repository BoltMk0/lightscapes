import { EventEmitter } from "node:events";
import mqtt, { type MqttClient } from "mqtt";
import type { AdapterHealth, InputInfo, LightId, LightInfo, ReportedState } from "../../../src/protocol/index.ts";
import { WARMEST_KELVIN, COOLEST_KELVIN, rgbToHex } from "../../../src/color/index.ts";
import type { Adapter, AdapterEvents, ResolvedState } from "./adapter.ts";

export type Zigbee2MqttOptions = {
    url: string;
    username?: string;
    password?: string;
    /** Zigbee2MQTT's base topic. */
    baseTopic: string;
    /** Logs what would be sent instead of sending it. */
    dryRun: boolean;
};

/** The parts of Zigbee2MQTT's bridge/devices payload used here. */
type Z2MExpose = {
    type?: string; name?: string; property?: string; values?: string[];
    value_min?: number; value_max?: number; features?: Z2MExpose[];
};
type Z2MDevice = {
    friendly_name: string;
    ieee_address?: string;
    type: string;
    definition?: { description?: string; vendor?: string; model?: string; exposes?: Z2MExpose[] } | null;
};
type Z2MGroup = { friendly_name: string; members?: { ieee_address: string }[] };

type Device = { name: string; ieee?: string; description: string; switchable: boolean; info: LightInfo['caps']; actions: string[] | null };

const PREFIX = 'z2m:';
const idOf = (name: string): LightId => PREFIX + name;
const nameOf = (id: LightId): string => id.slice(PREFIX.length);

function allExposes(exposes: Z2MExpose[]): Z2MExpose[] {
    return exposes.flatMap(e => [e, ...allExposes(e.features ?? [])]);
}

function describe(device: Z2MDevice): Device {
    const exposes = allExposes(device.definition?.exposes ?? []);
    const find = (name: string) => exposes.find(e => e.name === name || e.property === name);
    const temp = find('color_temp');
    const action = find('action');
    const { vendor, model, description } = device.definition ?? {};
    return {
        name: device.friendly_name,
        ieee: device.ieee_address,
        description: [vendor, model, description].filter(Boolean).join(' · '),
        switchable: find('state') !== undefined,
        info: {
            brightness: find('brightness') !== undefined,
            color: find('color_xy') !== undefined || find('color_hs') !== undefined,
            // A white's range comes in mireds: the most mireds is the warmest
            white: temp ? {
                minKelvin: temp.value_max ? Math.round(1_000_000 / temp.value_max) : WARMEST_KELVIN,
                maxKelvin: temp.value_min ? Math.round(1_000_000 / temp.value_min) : COOLEST_KELVIN
            } : undefined,
            effects: find('effect')?.values ?? []
        },
        actions: action ? (action.values ?? []) : null
    };
}

/** CIE xy, at full brightness, as sRGB. */
function xyToHex(x: number, y: number): string {
    if(y <= 0) return '#ffffff';
    const X = x / y, Z = (1 - x - y) / y;
    const linear = [
        3.2406 * X - 1.5372 - 0.4986 * Z,
        -0.9689 * X + 1.8758 + 0.0415 * Z,
        0.0557 * X - 0.2040 + 1.0570 * Z
    ].map(c => Math.max(c, 0));
    const max = Math.max(...linear) || 1;
    const [r, g, b] = linear.map(c => {
        const v = c / max;
        return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
    });
    return rgbToHex({ r, g, b });
}

/** A light's state from its Zigbee2MQTT message. */
function reportedState(message: Record<string, unknown>, previous: ReportedState | undefined, source: ReportedState['source']): ReportedState {
    const state: ReportedState = { on: previous?.on ?? null, reachable: previous?.reachable ?? null, source };
    if(previous?.brightness !== undefined) state.brightness = previous.brightness;
    if(previous?.color) state.color = previous.color;
    if(message.state === 'ON') state.on = true;
    else if(message.state === 'OFF') state.on = false;
    if(typeof message.brightness === 'number') state.brightness = Math.min(1, Math.max(0, message.brightness / 254));
    const color = message.color as { x?: number; y?: number } | undefined;
    if(message.color_mode === 'color_temp' && typeof message.color_temp === 'number' && message.color_temp > 0){
        state.color = { kind: 'white', kelvin: Math.round(1_000_000 / message.color_temp) };
    } else if(typeof color?.x === 'number' && typeof color.y === 'number' && message.color_mode !== 'color_temp'){
        state.color = { kind: 'rgb', hex: xyToHex(color.x, color.y) };
    }
    return state;
}

/** Zigbee2MQTT, over MQTT: its devices and groups as lights, its buttons as inputs. */
export class Zigbee2Mqtt extends EventEmitter implements Adapter {
    readonly id = 'z2m';
    readonly name = 'Zigbee2MQTT';
    readonly limits = { messagesPerSecond: 20, nativeFade: true, nativeGroups: true };

    #options: Zigbee2MqttOptions;
    #client: MqttClient;
    #mqttConnected = false;
    /** Whether Zigbee2MQTT says it's running, or null before it's said. */
    #bridgeOnline: boolean | null = null;
    #devices: Device[] = [];
    #groups: Z2MGroup[] = [];
    #states: Record<LightId, ReportedState> = {};

    /** Messages waiting to go, by topic: a newer one for the same topic replaces the older, merged. */
    #queue = new Map<string, Record<string, unknown>>();
    #pump: ReturnType<typeof setInterval> | null = null;

    constructor(options: Zigbee2MqttOptions) {
        super();
        this.#options = options;
        this.#client = mqtt.connect(options.url, { username: options.username, password: options.password, reconnectPeriod: 5000 });
        this.#client.on('connect', () => {
            this.#mqttConnected = true;
            console.log(`MQTT: connected to ${options.url}`);
            this.#client.subscribe(`${options.baseTopic}/#`);
            this.emit('health');
        });
        this.#client.on('close', () => {
            if(this.#mqttConnected){
                console.warn('MQTT: disconnected');
                this.#mqttConnected = false;
                this.emit('health');
            }
        });
        this.#client.on('error', err => console.warn('MQTT:', err.message));
        this.#client.on('message', (topic, payload, packet) => this.#handle(topic, payload, packet.retain));
    }

    override on<E extends keyof AdapterEvents>(event: E, listener: (...args: AdapterEvents[E]) => void): this {
        return super.on(event, listener as (...args: unknown[]) => void);
    }

    health(): AdapterHealth {
        const ok = this.#mqttConnected && this.#bridgeOnline === true;
        const detail = !this.#mqttConnected ? `Can't reach the MQTT broker at ${this.#options.url}`
            : this.#bridgeOnline === false ? 'Zigbee2MQTT is offline'
            : this.#bridgeOnline === null ? 'Waiting for Zigbee2MQTT'
            : this.#options.dryRun ? 'Dry run: the lights are logged, not set' : undefined;
        return { id: this.id, name: this.name, ok, ...(detail ? { detail } : {}) };
    }

    lights(): LightInfo[] {
        const devices = this.#devices.filter(d => d.switchable).map((d): LightInfo => ({
            id: idOf(d.name), name: d.name, kind: 'device', caps: d.info, ...(d.description ? { description: d.description } : {})
        }));
        const byIeee = new Map(this.#devices.filter(d => d.ieee).map(d => [d.ieee!, d]));
        const groups = this.#groups.map((g): LightInfo => {
            const members = (g.members ?? []).map(m => byIeee.get(m.ieee_address)).filter((d): d is Device => d !== undefined);
            const whites = members.map(m => m.info.white).filter(w => w !== undefined);
            return {
                id: idOf(g.friendly_name),
                name: g.friendly_name,
                kind: 'group',
                members: members.map(m => idOf(m.name)),
                // What any of its lights can do: each light does what it can of what the group's sent
                caps: {
                    brightness: members.some(m => m.info.brightness),
                    color: members.some(m => m.info.color),
                    white: whites.length ? {
                        minKelvin: Math.min(...whites.map(w => w.minKelvin)),
                        maxKelvin: Math.max(...whites.map(w => w.maxKelvin))
                    } : undefined,
                    effects: [...new Set(members.flatMap(m => m.info.effects))]
                },
                description: `Group of ${members.length}`
            };
        });
        return [...devices, ...groups].sort((a, b) => a.name.localeCompare(b.name));
    }

    inputs(): InputInfo[] {
        return this.#devices.filter(d => d.actions !== null).map(d => ({
            id: idOf(d.name), name: d.name, actions: d.actions, ...(d.description ? { description: d.description } : {})
        }));
    }

    states(): Record<LightId, ReportedState> {
        return { ...this.#states };
    }

    set(id: LightId, state: ResolvedState, fadeSeconds: number): void {
        const name = nameOf(id);
        const transition = Math.round(fadeSeconds * 10) / 10;
        let payload: Record<string, unknown>;
        if(!state.on) payload = { state: 'OFF', transition };
        else {
            payload = { state: 'ON', transition };
            if(state.brightness !== undefined) payload.brightness = Math.max(1, Math.round(state.brightness * 254));
            if(state.color?.kind === 'rgb') payload.color = { hex: state.color.hex };
            else if(state.color?.kind === 'white') payload.color_temp = Math.round(1_000_000 / state.color.kelvin);
        }
        // A newer state replaces one still waiting to go, and with it any effect that was to follow it
        this.#queue.delete(`${name}/set#effect`);
        this.#enqueue(`${name}/set`, payload, true);
        if(state.effect) this.#enqueue(`${name}/set#effect`, { effect: state.effect });
    }

    refreshStates(): void {
        for(const device of this.#devices.filter(d => d.switchable)){
            this.#enqueue(`${device.name}/get#state`, { state: '', brightness: '', color_temp: '', color: '' });
        }
    }

    close(): void {
        if(this.#pump) clearInterval(this.#pump);
        this.#client.end();
    }

    #enqueue(key: string, payload: Record<string, unknown>, replace = false) {
        // Delete first, so a replaced message goes to the back of the queue with the newest
        const merged = replace ? payload : { ...this.#queue.get(key), ...payload };
        this.#queue.delete(key);
        this.#queue.set(key, merged);
        this.#pump ??= setInterval(() => this.#sendNext(), 1000 / this.limits.messagesPerSecond);
    }

    #sendNext() {
        const next = this.#queue.entries().next();
        if(next.done){
            if(this.#pump) clearInterval(this.#pump);
            this.#pump = null;
            return;
        }
        const [key, payload] = next.value;
        this.#queue.delete(key);
        const topic = `${this.#options.baseTopic}/${key.replace(/#.*$/, '')}`;
        const message = JSON.stringify(payload);
        if(this.#options.dryRun){
            console.log(`[dry run] ${topic} ${message}`);
            return;
        }
        if(this.#mqttConnected) this.#client.publish(topic, message);
    }

    #handle(topic: string, payload: Buffer, retained: boolean) {
        const base = this.#options.baseTopic;
        if(!topic.startsWith(base + '/')) return;
        const subtopic = topic.slice(base.length + 1);

        if(subtopic === 'bridge/state'){
            // `{"state":"online"}` since Zigbee2MQTT 1.x's later versions, plain `online` before
            const text = payload.toString();
            let state = text;
            try { state = JSON.parse(text).state ?? text; } catch { /* plain text */ }
            const online = state === 'online';
            const was = this.#bridgeOnline;
            this.#bridgeOnline = online;
            if(online !== was){
                console[online ? 'log' : 'warn'](`Zigbee2MQTT: ${online ? 'online' : 'offline'}`);
                this.emit('health');
                if(online) this.emit('reconnected');
            }
            return;
        }
        if(subtopic === 'bridge/devices'){
            try {
                const devices = JSON.parse(payload.toString()) as Z2MDevice[];
                this.#devices = devices.filter(d => d.type !== 'Coordinator').map(describe).sort((a, b) => a.name.localeCompare(b.name));
                this.emit('inventory');
            } catch(err) { console.error('Zigbee2MQTT: bad device list', err); }
            return;
        }
        if(subtopic === 'bridge/groups'){
            try {
                this.#groups = JSON.parse(payload.toString()) as Z2MGroup[];
                this.emit('inventory');
            } catch(err) { console.error('Zigbee2MQTT: bad group list', err); }
            return;
        }
        if(subtopic.startsWith('bridge/')) return;

        if(subtopic.endsWith('/availability')){
            const name = subtopic.slice(0, -'/availability'.length);
            if(!this.#isKnown(name)) return;
            const text = payload.toString();
            let state = text;
            try { state = JSON.parse(text).state ?? text; } catch { /* plain text */ }
            const id = idOf(name);
            const previous = this.#states[id];
            this.#states[id] = { ...(previous ?? { on: null, source: 'reported' }), reachable: state === 'online' };
            this.emit('state', id, this.#states[id]);
            return;
        }

        // Device and group names can have slashes in, so match the whole rest of the topic against them
        const device = this.#devices.find(d => d.name === subtopic);
        const group = device ? undefined : this.#groups.find(g => g.friendly_name === subtopic);
        if(!device && !group) return;
        let message: Record<string, unknown>;
        try {
            message = JSON.parse(payload.toString());
            if(typeof message !== 'object' || message === null) return;
        } catch { return; }

        // A retained press is an old one, not the button being pressed now
        if(device && !retained && typeof message.action === 'string' && message.action !== ''){
            this.emit('input', idOf(device.name), message.action);
        }
        if(group || device?.switchable){
            const id = idOf(subtopic);
            // A group's state is Zigbee2MQTT's estimate, from what it was sent
            this.#states[id] = reportedState(message, this.#states[id], group ? 'assumed' : 'reported');
            this.emit('state', id, this.#states[id]);
        }
    }

    #isKnown(name: string): boolean {
        return this.#devices.some(d => d.name === name) || this.#groups.some(g => g.friendly_name === name);
    }
}
