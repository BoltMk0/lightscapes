import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { ENV } from "./env.ts";
import type { Hub } from "./hub.ts";

const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml'
};

class HttpError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

function send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req){
        size += chunk.length;
        if(size > MAX_BODY_BYTES) throw new HttpError(413, 'Too large');
        chunks.push(chunk);
    }
    try {
        const value = size === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(typeof value !== 'object' || value === null) throw new Error();
        return value;
    } catch {
        throw new HttpError(400, 'Not JSON');
    }
}

/** HTTP basic auth against LIGHTSCAPES_PASSWORD, any user name, if one's set. */
function authorized(req: IncomingMessage): boolean {
    if(!ENV.password) return true;
    const match = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if(!match) return false;
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
    const expected = Buffer.from(ENV.password);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The hub's own page: where it connects, and what it has. */
export function startServer(hub: Hub) {
    async function api(req: IncomingMessage, res: ServerResponse, path: string) {
        const method = req.method ?? 'GET';

        if(path === '/api/status' && method === 'GET') return send(res, 200, hub.status());

        if(path === '/api/lights' && method === 'GET') return send(res, 200, hub.lights());

        if(path === '/api/settings' && method === 'PUT'){
            const body = await readJson(req);
            const url = typeof body.url === 'string' ? body.url.trim().replace(/\/+$/, '') : '';
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            if(url && !/^https?:\/\/[^/]+/.test(url)) throw new HttpError(400, 'The address should start with http:// or https://');
            if(!name) throw new HttpError(400, 'Give the hub a name');
            if(name.length > 60) throw new HttpError(400, 'Keep the name to 60 characters');
            hub.updateSettings(url, name);
            return send(res, 200, hub.status());
        }

        if(path === '/api/retry' && method === 'POST'){
            hub.askAgain();
            return send(res, 200, hub.status());
        }

        throw new HttpError(404, 'Not found');
    }

    async function serveFile(res: ServerResponse, path: string) {
        const relative = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
        const file = join(ENV.publicDir, relative);
        if(!file.startsWith(ENV.publicDir)) throw new HttpError(404, 'Not found');
        const extension = relative.slice(relative.lastIndexOf('.'));
        try {
            const content = await readFile(file);
            res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
            res.end(content);
        } catch {
            throw new HttpError(404, 'Not found');
        }
    }

    const server = createServer(async (req, res) => {
        if(!authorized(req)){
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Lightscapes"' });
            res.end('Unauthorized');
            return;
        }
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        try {
            if(path.startsWith('/api/')) await api(req, res, path);
            else if(req.method === 'GET' || req.method === 'HEAD') await serveFile(res, path);
            else throw new HttpError(405, 'Method not allowed');
        } catch(err) {
            if(res.headersSent) return;
            if(err instanceof HttpError) send(res, err.status, { error: err.message });
            else {
                console.error(err);
                send(res, 500, { error: 'Something went wrong' });
            }
        }
    });
    server.listen(ENV.port, () => console.log(`Lightscapes: hub page on port ${ENV.port}`));
    return server;
}
