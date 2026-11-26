import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { checkAppMessage, type AssignMessage } from "../../src/protocol/index.ts";
import { ENV } from "./env.ts";

/** Who the hub is, and the app it connects to. */
export type HubSettings = {
    /** Made on first start, and kept: the app knows the hub by it. */
    hubId: string;
    /** Made on first start, and kept: the app approved the hub with it. Never shown. */
    secret: string;
    /** What the app shows the hub as. */
    name: string;
    /** The app's Lightscapes address, e.g. https://clockmaker.example/lightscapes. */
    url: string;
    /** The address the app turned the hub away from, so it doesn't keep asking until the address changes. */
    rejectedUrl?: string;
};

const SETTINGS_FILE = join(ENV.dataDir, 'hub.json');
const ASSIGN_FILE = join(ENV.dataDir, 'assign.json');
/** Lightscapes' settings from before an app drove it, offered to the app to import. */
const LEGACY_FILE = join(ENV.dataDir, 'lightscapes.json');

function writeJson(file: string, value: unknown) {
    mkdirSync(ENV.dataDir, { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, '\t'));
    renameSync(temp, file);
}

export function loadSettings(): HubSettings {
    let saved: Partial<HubSettings> = {};
    if(existsSync(SETTINGS_FILE)){
        try {
            saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
        } catch(err) {
            console.error(`Couldn't read ${SETTINGS_FILE}:`, err);
        }
    }
    const legacyUrl = readLegacy()?.clockmaker?.url;
    const settings: HubSettings = {
        hubId: typeof saved.hubId === 'string' && saved.hubId ? saved.hubId : randomUUID(),
        secret: typeof saved.secret === 'string' && saved.secret ? saved.secret : randomBytes(32).toString('base64url'),
        name: typeof saved.name === 'string' && saved.name ? saved.name : 'Lightscapes hub',
        // A hub that followed Clockmaker before keeps its address, with Lightscapes' path on the end
        url: typeof saved.url === 'string' ? saved.url : typeof legacyUrl === 'string' && legacyUrl ? `${legacyUrl.replace(/\/+$/, '')}/lightscapes` : '',
        ...(typeof saved.rejectedUrl === 'string' ? { rejectedUrl: saved.rejectedUrl } : {})
    };
    if(JSON.stringify(settings) !== JSON.stringify(saved)) saveSettings(settings);
    return settings;
}

export function saveSettings(settings: HubSettings): void {
    writeJson(SETTINGS_FILE, settings);
}

/** The last assignment the app sent, to put the lights back after a restart before the app's reached again. */
export function loadAssign(): AssignMessage | null {
    if(!existsSync(ASSIGN_FILE)) return null;
    try {
        const message = checkAppMessage(JSON.parse(readFileSync(ASSIGN_FILE, 'utf8')));
        return message.type === 'assign' ? message : null;
    } catch(err) {
        console.error(`Couldn't read ${ASSIGN_FILE}:`, err);
        return null;
    }
}

export function saveAssign(message: AssignMessage): void {
    writeJson(ASSIGN_FILE, message);
}

export function readLegacy(): { clockmaker?: { url?: unknown } } & Record<string, unknown> | null {
    if(!existsSync(LEGACY_FILE)) return null;
    try {
        return JSON.parse(readFileSync(LEGACY_FILE, 'utf8'));
    } catch {
        return null;
    }
}
