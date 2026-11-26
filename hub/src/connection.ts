import { EventEmitter } from "node:events";
import { createParser } from "eventsource-parser";
import {
    PROTOCOL_VERSION, STREAM_TIMEOUT_MS, authorizationHeader, checkAppMessage,
    type AdapterHealth, type AppMessage, type HelloMessage, type HubMessage
} from "../../src/protocol/index.ts";
import type { HubSettings } from "./settings.ts";

export type ConnectionState = 'unconfigured' | 'connecting' | 'pending' | 'accepted' | 'rejected' | 'error';

const MAX_BACKOFF_MS = 30_000;
/** How many of the latest syncs the app's clock offset is estimated from. */
const SYNC_SAMPLES = 20;
/** Messages to the app wait this long, so those sent together go together. */
const POST_DELAY_MS = 100;

export interface AppConnection {
    /** A message from the app, once the hub's accepted (welcome and sync are handled here). */
    on(event: 'message', listener: (message: AppMessage) => void): this;
    /** The app accepted the hub, on this connection: tell it everything. */
    on(event: 'accepted', listener: () => void): this;
    on(event: 'state', listener: (state: ConnectionState) => void): this;
}

/** The hub's connection to the app it's pointed at, reconnecting whenever it drops. */
export class AppConnection extends EventEmitter {
    state: ConnectionState = 'unconfigured';
    error: string | null = null;

    #settings: HubSettings | null = null;
    #hello: () => Omit<HelloMessage, 'type' | 'hubId' | 'name'>;
    #onRejected: (url: string) => void;
    #abort: AbortController | null = null;
    /** The app's time minus local time, from the newest syncs. */
    #offsets: number[] = [];
    #outbox: HubMessage[] = [];
    #postTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(hello: () => Omit<HelloMessage, 'type' | 'hubId' | 'name'>, onRejected: (url: string) => void) {
        super();
        this.#hello = hello;
        this.#onRejected = onRejected;
    }

    /** (Re)connects with new settings, if they changed. */
    configure(settings: HubSettings) {
        const key = (s: HubSettings | null) => JSON.stringify(s && [s.url, s.name, s.hubId, s.secret, s.rejectedUrl]);
        if(key(settings) === key(this.#settings)) return;
        this.#settings = { ...settings };
        this.#abort?.abort();
        this.#abort = null;
        if(!settings.url){
            this.#setState('unconfigured', null);
            return;
        }
        if(settings.rejectedUrl === settings.url){
            this.#setState('rejected', this.error ?? 'Turned away by the app. Change the address to ask again.');
            return;
        }
        const abort = new AbortController();
        this.#abort = abort;
        this.#run(settings, abort.signal);
    }

    stop() {
        this.#abort?.abort();
        this.#abort = null;
    }

    /** The app's clock now, as near as can be told. */
    now(): number {
        // Each sample is late by however long it took to arrive, so the largest is the closest
        const offset = this.#offsets.length ? Math.max(...this.#offsets) : 0;
        return Date.now() + offset;
    }

    /** Sends the app a message, if it's accepted the hub; otherwise it's dropped (the hub says everything on accept). */
    send(message: HubMessage) {
        if(this.state !== 'accepted') return;
        // A newer whole message of these replaces an older one still waiting
        if(message.type === 'inventory' || message.type === 'states' || message.type === 'status'){
            this.#outbox = this.#outbox.filter(m => m.type !== message.type);
        }
        this.#outbox.push(message);
        this.#postTimer ??= setTimeout(() => this.#flush(), POST_DELAY_MS);
    }

    async #flush() {
        this.#postTimer = null;
        const settings = this.#settings;
        const messages = this.#outbox;
        this.#outbox = [];
        if(!settings || messages.length === 0 || this.state !== 'accepted') return;
        try {
            const response = await fetch(`${settings.url}/messages`, {
                method: 'POST',
                headers: { Authorization: authorizationHeader(settings.hubId, settings.secret), 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages }),
                signal: AbortSignal.timeout(10_000)
            });
            if(!response.ok) console.warn(`App: ${response.status} sending ${messages.length} message(s): ${await response.text()}`);
        } catch(err) {
            console.warn('App: couldn\'t send:', err instanceof Error ? err.message : err);
        }
    }

    #setState(state: ConnectionState, error: string | null) {
        const changed = state !== this.state || error !== this.error;
        this.state = state;
        this.error = error;
        if(changed) this.emit('state', state);
    }

    async #run(settings: HubSettings, signal: AbortSignal) {
        let backoff = 1000;
        while(!signal.aborted){
            this.#setState('connecting', this.error);
            try {
                await this.#follow(settings, signal, () => backoff = 1000);
                if(signal.aborted || this.state === 'rejected') return;
                this.#setState('error', 'The connection closed');
            } catch(err) {
                if(signal.aborted) return;
                const message = err instanceof Error ? (err.name === 'TimeoutError' ? 'Timed out' : err.message) : String(err);
                this.#setState('error', message);
                console.warn(`App: ${message}; retrying in ${backoff / 1000}s`);
            }
            await new Promise(resolve => setTimeout(resolve, backoff));
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
    }

    async #follow(settings: HubSettings, signal: AbortSignal, onConnected: () => void) {
        // Stopped by the watchdog or the connection's own abort, whichever comes first
        const local = new AbortController();
        const stopLocal = () => local.abort();
        signal.addEventListener('abort', stopLocal);
        let lastMessage = Date.now();
        const watchdog = setInterval(() => {
            if(Date.now() - lastMessage > STREAM_TIMEOUT_MS) local.abort(new Error('The app stopped sending'));
        }, 1000);

        try {
            const hello: HelloMessage = { type: 'hello', hubId: settings.hubId, name: settings.name, ...this.#hello() };
            const response = await fetch(`${settings.url}/connect`, {
                method: 'POST',
                headers: {
                    Authorization: authorizationHeader(settings.hubId, settings.secret),
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream'
                },
                body: JSON.stringify(hello),
                signal: local.signal
            });
            if(!response.ok){
                const text = (await response.text()).slice(0, 200);
                throw new Error(response.status === 401 ? `Refused: ${text}` : `${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
            }
            if(!response.body) throw new Error('No event stream');
            this.#offsets = [];
            onConnected();
            console.log(`App: connected to ${settings.url}`);

            const parser = createParser({
                onEvent: (event) => {
                    lastMessage = Date.now();
                    try {
                        this.#handle(checkAppMessage(JSON.parse(event.data)), settings);
                    } catch(err) {
                        console.error('App: bad message', err instanceof Error ? err.message : err);
                    }
                }
            });
            const decoder = new TextDecoder();
            for await (const chunk of response.body){
                lastMessage = Date.now();
                parser.feed(decoder.decode(chunk, { stream: true }));
                if(this.state === 'rejected') break;
            }
        } catch(err) {
            // Report why the watchdog stopped it, rather than just that it was aborted
            if(local.signal.aborted && !signal.aborted && local.signal.reason instanceof Error) throw local.signal.reason;
            throw err;
        } finally {
            clearInterval(watchdog);
            signal.removeEventListener('abort', stopLocal);
            local.abort();
        }
    }

    #handle(message: AppMessage, settings: HubSettings) {
        switch(message.type){
            case 'sync':
                this.#offsets.push(message.serverTime - Date.now());
                if(this.#offsets.length > SYNC_SAMPLES) this.#offsets.shift();
                return;
            case 'welcome':
                if(message.result === 'pending'){
                    this.#setState('pending', null);
                    console.log('App: waiting to be approved');
                } else if(message.result === 'rejected'){
                    this.#setState('rejected', message.reason ?? 'Turned away by the app');
                    console.warn(`App: turned away: ${message.reason ?? 'no reason given'}`);
                    this.#onRejected(settings.url);
                } else {
                    this.#setState('accepted', null);
                    console.log('App: accepted');
                    this.emit('accepted');
                }
                return;
            default:
                if(this.state === 'accepted') this.emit('message', message);
        }
    }
}

export function helloFor(version: string, adapters: () => AdapterHealth[]): () => Omit<HelloMessage, 'type' | 'hubId' | 'name'> {
    return () => ({ hubVersion: version, protocol: PROTOCOL_VERSION, adapters: adapters() });
}
