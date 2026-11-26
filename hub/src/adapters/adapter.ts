import type { AdapterHealth, InputInfo, LightId, LightInfo, LightState, ReportedState, TimelineColor } from "../../../src/protocol/index.ts";

/** What a light is sent: a light state with its colour worked out (never a timeline). */
export type ResolvedState = Omit<LightState, 'color'> & { color?: TimelineColor };

export interface AdapterEvents {
    /** The lights or inputs changed. */
    inventory: [];
    /** A light's state changed (as reported, or as last sent). */
    state: [id: LightId, state: ReportedState];
    /** A button (or other input) was pressed or moved. */
    input: [device: string, action: string, value?: number];
    /** The adapter's health changed. */
    health: [];
    /** The hardware came back after being away, so the lights may need setting again. */
    reconnected: [];
}

/**
 * Something lights and buttons are reached through, like Zigbee2MQTT. Every light and input id starts with the
 * adapter's id and a colon (`z2m:table-lamp`), so two adapters' can't clash.
 */
export interface Adapter {
    readonly id: string;
    readonly name: string;
    /** How hard the hardware can be driven. */
    readonly limits: {
        /** The most light messages a second; more are queued, the newest for each light replacing the older. */
        messagesPerSecond: number;
        /** Whether lights fade by themselves, given a fade time. */
        nativeFade: boolean;
        /** Whether a group is set with one message. */
        nativeGroups: boolean;
    };
    health(): AdapterHealth;
    lights(): LightInfo[];
    inputs(): InputInfo[];
    states(): Record<LightId, ReportedState>;
    /** Sets a light or group, fading over `fadeSeconds`. Then plays its effect, if it has one. */
    set(id: LightId, state: ResolvedState, fadeSeconds: number): void;
    /** Asks the lights for their state again, where the hardware can. */
    refreshStates(): void;
    on<E extends keyof AdapterEvents>(event: E, listener: (...args: AdapterEvents[E]) => void): this;
    close(): void;
}
