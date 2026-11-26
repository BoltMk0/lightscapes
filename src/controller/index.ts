// The app's side of the connection: hubs pair by asking and being approved, then each one that's online has an event
// stream the app sends its messages down. Built on the web's Request and Response, so any server that has them can
// hand it the two routes (see the transport notes in the protocol).

import { createHash, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import {
    PROTOCOL_VERSION, ProtocolError, SYNC_INTERVAL_MS, checkHello, checkHubMessage, parseAuthorization,
    type Activity, type AdapterHealth, type AppMessage, type AssignMessage, type InputInfo, type InputMessage,
    type LightId, type LightInfo, type ReportedState
} from "../protocol/index.ts";

/** A hub the app knows, as it's kept. */
export type HubRecord = {
    hubId: string;
    /** The name the hub gives itself. */
    name: string;
    status: 'pending' | 'approved';
    /** SHA-256 of the secret the hub first connected with, as hex. */
    secretHash: string;
    requestedAt: number;
    approvedAt?: number;
    lastSeenAt?: number;
    hubVersion?: string;
    /** The lights and inputs it last said it has, so they can be picked while it's offline. */
    inventory?: { lights: LightInfo[]; inputs: InputInfo[] };
};

/** Where the hubs are kept between restarts. */
export interface HubStore {
    load(): HubRecord[];
    save(records: HubRecord[]): void;
}

/** A hub as the app shows it. */
export type HubView = Omit<HubRecord, 'secretHash'> & {
    online: boolean;
    adapters: AdapterHealth[];
    activity: Activity[];
    states: Record<LightId, ReportedState>;
};

export type ControllerOptions = {
    store: HubStore;
    /** What an accepted hub is sent whenever it connects, and when `reassign` is called. */
    assignmentFor(hubId: string): Omit<AssignMessage, 'type'>;
    /** The most hubs waiting for approval at once. */
    maxPending?: number;
    /** How long a hub waits for approval before it's forgotten. */
    pendingMs?: number;
    /** The app's time; hubs follow it. */
    now?: () => number;
};

type Session = {
    controller: ReadableStreamDefaultController<Uint8Array>;
    sync: ReturnType<typeof setInterval>;
    adapters: AdapterHealth[];
    activity: Activity[];
    states: Record<LightId, ReportedState>;
    closed: boolean;
    /** Which connection this is, so an older one closing after a reconnect doesn't take the hub offline. */
    token: object;
};

export interface LightscapesController {
    /** A hub was added, approved, removed, came online or went offline, or said what it has. */
    on(event: 'change', listener: (hubId: string) => void): this;
    on(event: 'input', listener: (hubId: string, input: InputMessage) => void): this;
    on(event: 'states', listener: (hubId: string) => void): this;
    on(event: 'legacyConfig', listener: (hubId: string, config: unknown) => void): this;
}

const encoder = new TextEncoder();

function hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
}

function sameHash(a: string, b: string): boolean {
    const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
    return x.length === y.length && timingSafeEqual(x, y);
}

function text(status: number, body: string): Response {
    return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

export class LightscapesController extends EventEmitter {
    #options: Required<ControllerOptions>;
    #records = new Map<string, HubRecord>();
    #sessions = new Map<string, Session>();

    constructor(options: ControllerOptions) {
        super();
        this.#options = { maxPending: 10, pendingMs: 24 * 60 * 60 * 1000, now: Date.now, ...options };
        for(const record of options.store.load()) this.#records.set(record.hubId, record);
    }

    // --- For the app's pages ------------------------------------------------------------------------------------

    hubs(): HubView[] {
        this.#forgetStalePending();
        return [...this.#records.values()].map(r => this.#view(r));
    }

    hub(hubId: string): HubView | null {
        const record = this.#records.get(hubId);
        return record ? this.#view(record) : null;
    }

    isOnline(hubId: string): boolean {
        return this.#sessions.has(hubId) && this.#records.get(hubId)?.status === 'approved';
    }

    approve(hubId: string): void {
        const record = this.#records.get(hubId);
        if(!record || record.status === 'approved') return;
        record.status = 'approved';
        record.approvedAt = this.#options.now();
        this.#save();
        // Waiting on its stream: welcomed in now
        if(this.#sessions.has(hubId)) this.#welcome(hubId);
        this.emit('change', hubId);
    }

    /** Turns a waiting hub away, or removes an approved one. It's told, and stops connecting until it's set up again. */
    remove(hubId: string, reason = 'Removed in the app'): void {
        if(!this.#records.delete(hubId)) return;
        this.#save();
        this.#send(hubId, { type: 'welcome', result: 'rejected', protocol: PROTOCOL_VERSION, reason });
        this.#close(hubId);
        this.emit('change', hubId);
    }

    /** Sends a message to a hub, if it's online and approved. Returns whether it was sent. */
    send(hubId: string, message: AppMessage): boolean {
        if(!this.isOnline(hubId)) return false;
        return this.#send(hubId, message);
    }

    /** Sends a hub everything again, from `assignmentFor`. */
    reassign(hubId: string): boolean {
        return this.send(hubId, { type: 'assign', ...this.#options.assignmentFor(hubId) });
    }

    /** Closes every hub's stream (they'll reconnect to whatever serves the routes next). */
    close(): void {
        for(const hubId of [...this.#sessions.keys()]) this.#close(hubId);
    }

    // --- The routes ---------------------------------------------------------------------------------------------

    /** POST <url>/connect: checks the hub, and answers with its event stream. */
    async handleConnect(request: Request): Promise<Response> {
        const auth = parseAuthorization(request.headers.get('authorization'));
        if(!auth) return text(401, 'Expected Authorization: Bearer <hubId>.<secret>');
        let hello;
        try {
            hello = checkHello(await request.json());
        } catch(err) {
            return text(400, err instanceof ProtocolError ? err.message : 'Not JSON');
        }
        if(hello.hubId !== auth.hubId) return text(400, "The hub id doesn't match the Authorization header");

        this.#forgetStalePending();
        let record = this.#records.get(auth.hubId);
        if(!record){
            const pending = [...this.#records.values()].filter(r => r.status === 'pending').length;
            if(pending >= this.#options.maxPending) return text(429, 'Too many hubs are waiting for approval');
            record = { hubId: auth.hubId, name: hello.name, status: 'pending', secretHash: hashSecret(auth.secret), requestedAt: this.#options.now() };
            this.#records.set(record.hubId, record);
        } else if(!sameHash(record.secretHash, hashSecret(auth.secret))){
            return text(401, "This hub's secret doesn't match the one it was approved with");
        }
        record.name = hello.name;
        record.hubVersion = hello.hubVersion;
        record.lastSeenAt = this.#options.now();
        this.#save();

        const hubId = record.hubId;
        // A newer connection replaces an older one (e.g. one that dropped without the app noticing)
        this.#close(hubId);
        const token = {};

        const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
                const session: Session = {
                    controller,
                    sync: setInterval(() => this.#send(hubId, { type: 'sync', serverTime: this.#options.now() }), SYNC_INTERVAL_MS),
                    adapters: hello.adapters,
                    activity: [],
                    states: {},
                    closed: false,
                    token
                };
                this.#sessions.set(hubId, session);
                if(hello.protocol !== PROTOCOL_VERSION){
                    this.#send(hubId, {
                        type: 'welcome', result: 'rejected', protocol: PROTOCOL_VERSION,
                        reason: `The app speaks protocol ${PROTOCOL_VERSION} and the hub ${hello.protocol}: update the older one`
                    });
                    this.#close(hubId);
                    return;
                }
                this.#welcome(hubId);
                this.emit('change', hubId);
            },
            cancel: () => this.#closeSession(hubId, token)
        });
        request.signal.addEventListener('abort', () => this.#closeSession(hubId, token));

        return new Response(stream, {
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }
        });
    }

    /** POST <url>/messages: what an approved hub sends. */
    async handleMessages(request: Request): Promise<Response> {
        const auth = parseAuthorization(request.headers.get('authorization'));
        const record = auth && this.#records.get(auth.hubId);
        if(!auth || !record || !sameHash(record.secretHash, hashSecret(auth.secret))) return text(401, 'Unknown hub');
        if(record.status !== 'approved') return text(403, 'Not approved yet');
        let messages;
        try {
            const body = await request.json() as { messages?: unknown };
            if(!Array.isArray(body?.messages)) throw new ProtocolError('messages: should be a list');
            messages = body.messages.map(checkHubMessage);
        } catch(err) {
            return text(400, err instanceof ProtocolError ? err.message : 'Not JSON');
        }

        const hubId = record.hubId;
        const session = this.#sessions.get(hubId);
        record.lastSeenAt = this.#options.now();
        for(const message of messages){
            switch(message.type){
                case 'inventory':
                    record.inventory = { lights: message.lights, inputs: message.inputs };
                    this.#save();
                    this.emit('change', hubId);
                    break;
                case 'states':
                    if(session) session.states = message.states;
                    this.emit('states', hubId);
                    break;
                case 'state':
                    if(session) session.states[message.id] = message.state;
                    this.emit('states', hubId);
                    break;
                case 'status':
                    if(session){
                        session.adapters = message.adapters;
                        session.activity = message.activity;
                    }
                    this.emit('change', hubId);
                    break;
                case 'input':
                    this.emit('input', hubId, message);
                    break;
                case 'legacyConfig':
                    this.emit('legacyConfig', hubId, message.config);
                    break;
            }
        }
        return new Response(null, { status: 204 });
    }

    // --- Inside -------------------------------------------------------------------------------------------------

    #view(record: HubRecord): HubView {
        const { secretHash: _, ...rest } = record;
        const session = this.#sessions.get(record.hubId);
        return {
            ...rest,
            online: session !== undefined,
            adapters: session?.adapters ?? [],
            activity: session?.activity ?? [],
            states: session?.states ?? {}
        };
    }

    #welcome(hubId: string) {
        const record = this.#records.get(hubId);
        if(!record) return;
        if(record.status === 'pending'){
            this.#send(hubId, { type: 'welcome', result: 'pending', protocol: PROTOCOL_VERSION });
            return;
        }
        this.#send(hubId, { type: 'welcome', result: 'accepted', protocol: PROTOCOL_VERSION });
        this.#send(hubId, { type: 'sync', serverTime: this.#options.now() });
        this.#send(hubId, { type: 'assign', ...this.#options.assignmentFor(hubId) });
    }

    #send(hubId: string, message: AppMessage): boolean {
        const session = this.#sessions.get(hubId);
        if(!session || session.closed) return false;
        try {
            session.controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
            return true;
        } catch {
            this.#close(hubId);
            return false;
        }
    }

    #closeSession(hubId: string, token: object) {
        if(this.#sessions.get(hubId)?.token === token) this.#close(hubId);
    }

    #close(hubId: string) {
        const session = this.#sessions.get(hubId);
        if(!session) return;
        this.#sessions.delete(hubId);
        session.closed = true;
        clearInterval(session.sync);
        try { session.controller.close(); } catch { /* already closed */ }
        const record = this.#records.get(hubId);
        if(record){
            record.lastSeenAt = this.#options.now();
            this.#save();
        }
        this.emit('change', hubId);
    }

    #forgetStalePending() {
        const cutoff = this.#options.now() - this.#options.pendingMs;
        let changed = false;
        for(const record of [...this.#records.values()]){
            if(record.status === 'pending' && record.requestedAt < cutoff && !this.#sessions.has(record.hubId)){
                this.#records.delete(record.hubId);
                changed = true;
            }
        }
        if(changed) this.#save();
    }

    #save() {
        this.#options.store.save([...this.#records.values()]);
    }
}
