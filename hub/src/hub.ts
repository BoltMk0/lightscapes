import type { Activity, AppMessage, AssignMessage, InputInfo, LightId, LightInfo, ReportedState } from "../../src/protocol/index.ts";
import type { Adapter } from "./adapters/adapter.ts";
import { AppConnection, helloFor } from "./connection.ts";
import { Renderer } from "./renderer.ts";
import { loadAssign, loadSettings, readLegacy, saveAssign, saveSettings, type HubSettings } from "./settings.ts";
import { ENV } from "./env.ts";

const ACTIVITY_LENGTH = 50;
/** Status goes to the app at most this often. */
const STATUS_DELAY_MS = 500;
/** The assignment's saved this long after it last changed, so a busy game doesn't write the disk constantly. */
const SAVE_DELAY_MS = 2000;

/** The hub: its adapters, kept in step with the app it's connected to. */
export class Hub {
    readonly version: string;
    readonly adapters: Adapter[];
    readonly connection: AppConnection;
    readonly renderer: Renderer;
    activity: Activity[] = [];

    #settings: HubSettings;
    #assign: AssignMessage | null;
    #statusTimer: ReturnType<typeof setTimeout> | null = null;
    #saveTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(version: string, adapters: Adapter[]) {
        this.version = version;
        this.adapters = adapters;
        this.#settings = loadSettings();
        this.connection = new AppConnection(
            helloFor(version, () => adapters.map(a => a.health())),
            url => {
                this.#settings = { ...this.#settings, rejectedUrl: url };
                saveSettings(this.#settings);
                this.connection.configure(this.#settings);
            }
        );
        this.renderer = new Renderer(adapters, this.connection, text => this.log(text));

        // Until the app's reached, the lights show what it last asked for
        this.#assign = loadAssign();
        if(this.#assign){
            this.log(this.#assign.following ? `Following ${this.#assign.following.name}, as when last connected` : 'Following nothing, as when last connected');
            this.renderer.assign(this.#assign.program, this.#assign.layers);
        }

        this.connection.on('state', state => {
            const error = this.connection.error;
            if(state === 'pending') this.log('Waiting to be approved in the app');
            else if(state === 'accepted') this.log('Connected to the app');
            else if(state === 'rejected') this.log(`Turned away by the app${error ? `: ${error}` : ''}`);
            else if(state === 'error') this.log(`App: ${error}`);
            this.#sendStatus();
        });
        this.connection.on('accepted', () => this.#sendEverything());
        this.connection.on('message', message => this.#handle(message));

        for(const adapter of adapters){
            adapter.on('inventory', () => this.connection.send({ type: 'inventory', ...this.lights() }));
            adapter.on('state', (id, state) => this.connection.send({ type: 'state', id, state }));
            adapter.on('input', (device, action, value) => {
                this.log(`${device}: ${action}`);
                this.connection.send({ type: 'input', device, action, at: this.connection.now(), ...(value !== undefined ? { value } : {}) });
            });
            adapter.on('health', () => this.#sendStatus());
            // The lights may have been changed while it was away
            adapter.on('reconnected', () => this.renderer.reset());
        }

        this.connection.configure(this.#settings);
    }

    log(text: string) {
        console.log(text);
        this.activity.unshift({ at: Date.now(), text });
        this.activity.length = Math.min(this.activity.length, ACTIVITY_LENGTH);
        this.#sendStatus();
    }

    lights(): { lights: LightInfo[]; inputs: InputInfo[]; states: Record<LightId, ReportedState> } {
        return {
            lights: this.adapters.flatMap(a => a.lights()),
            inputs: this.adapters.flatMap(a => a.inputs()),
            states: Object.assign({}, ...this.adapters.map(a => a.states()))
        };
    }

    status() {
        return {
            hub: { hubId: this.#settings.hubId, name: this.#settings.name, version: this.version },
            app: { url: this.#settings.url, state: this.connection.state, error: this.connection.error },
            following: this.#assign?.following ?? null,
            adapters: this.adapters.map(a => a.health()),
            dryRun: ENV.dryRun,
            activity: this.activity
        };
    }

    updateSettings(url: string, name: string) {
        const changedUrl = url !== this.#settings.url;
        this.#settings = { ...this.#settings, url, name };
        // A new address is asked afresh
        if(changedUrl) delete this.#settings.rejectedUrl;
        saveSettings(this.#settings);
        this.connection.configure(this.#settings);
    }

    /** Asks the app again after it turned the hub away. */
    askAgain() {
        delete this.#settings.rejectedUrl;
        saveSettings(this.#settings);
        this.connection.configure(this.#settings);
    }

    stop() {
        this.connection.stop();
        this.renderer.stop();
        for(const adapter of this.adapters) adapter.close();
        if(this.#saveTimer) this.#saveNow();
    }

    #handle(message: AppMessage) {
        switch(message.type){
            case 'assign': {
                const was = this.#assign?.following?.id ?? null;
                this.#assign = message;
                if((message.following?.id ?? null) !== was || !this.activity.some(a => a.text.startsWith('Following'))){
                    this.log(message.following ? `Following ${message.following.name}` : 'Following nothing');
                }
                this.renderer.assign(message.program, message.layers);
                this.#saveSoon();
                this.#sendStatus();
                return;
            }
            case 'program':
                if(this.#assign) this.#assign = { ...this.#assign, program: message.program };
                this.renderer.setProgram(message.program);
                this.#saveSoon();
                return;
            case 'layers':
                if(this.#assign) this.#assign = { ...this.#assign, layers: message.layers };
                this.renderer.setLayers(message.layers);
                this.#saveSoon();
                return;
            case 'cue':
                this.log(`Cue: ${message.layer.id}`);
                this.renderer.cue(message.layer, message.at);
                return;
            case 'endCue':
                this.renderer.endCue(message.id);
                return;
            case 'getStates':
                for(const adapter of this.adapters) adapter.refreshStates();
                this.connection.send({ type: 'states', states: this.lights().states });
                return;
        }
    }

    /** All the app needs to know, whenever it accepts the hub. */
    #sendEverything() {
        const { lights, inputs, states } = this.lights();
        this.connection.send({ type: 'inventory', lights, inputs });
        this.connection.send({ type: 'states', states });
        this.#sendStatusNow();
        const legacy = readLegacy();
        if(legacy) this.connection.send({ type: 'legacyConfig', config: legacy });
    }

    #sendStatus() {
        this.#statusTimer ??= setTimeout(() => this.#sendStatusNow(), STATUS_DELAY_MS);
    }

    #sendStatusNow() {
        if(this.#statusTimer) clearTimeout(this.#statusTimer);
        this.#statusTimer = null;
        this.connection.send({ type: 'status', adapters: this.adapters.map(a => a.health()), activity: this.activity });
    }

    #saveSoon() {
        if(this.#saveTimer) clearTimeout(this.#saveTimer);
        this.#saveTimer = setTimeout(() => this.#saveNow(), SAVE_DELAY_MS);
    }

    #saveNow() {
        if(this.#saveTimer) clearTimeout(this.#saveTimer);
        this.#saveTimer = null;
        if(this.#assign) saveAssign(this.#assign);
    }
}
