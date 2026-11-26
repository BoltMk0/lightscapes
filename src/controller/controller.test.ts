import { test } from "node:test";
import assert from "node:assert/strict";
import { LightscapesController, type HubRecord } from "./index.ts";
import { PROTOCOL_VERSION, authorizationHeader, type AppMessage, type HelloMessage, type InputMessage } from "../protocol/index.ts";

function memoryStore(initial: HubRecord[] = []) {
    let records = initial;
    return { load: () => records, save: (r: HubRecord[]) => { records = structuredClone(r); }, get records() { return records; } };
}

function controller(store = memoryStore()) {
    return new LightscapesController({
        store,
        assignmentFor: () => ({ following: null, program: { scenes: {}, timelines: {}, fadeSeconds: 1 }, layers: [] }),
        now: () => 1000
    });
}

const hello = (overrides: Partial<HelloMessage> = {}): HelloMessage =>
    ({ type: 'hello', hubId: 'hub1', name: 'Living room', hubVersion: '2.0.0', protocol: PROTOCOL_VERSION, adapters: [], ...overrides });

function connect(c: LightscapesController, secret = 'secret1', body: HelloMessage = hello()) {
    const abort = new AbortController();
    const response = c.handleConnect(new Request('http://app/lightscapes/connect', {
        method: 'POST',
        headers: { Authorization: authorizationHeader(body.hubId, secret) },
        body: JSON.stringify(body),
        signal: abort.signal
    }));
    return { response, abort };
}

/** Reads app messages off an event stream as they come. */
function reader(response: Response) {
    const r = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return async function next(): Promise<AppMessage> {
        for(;;){
            const end = buffer.indexOf('\n\n');
            if(end >= 0){
                const event = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const message = JSON.parse(event.replace(/^data: /, '')) as AppMessage;
                if(message.type !== 'sync') return message;
                continue;
            }
            const { value, done } = await r.read();
            if(done) throw new Error('stream closed');
            buffer += decoder.decode(value, { stream: true });
        }
    };
}

function post(c: LightscapesController, messages: unknown[], secret = 'secret1') {
    return c.handleMessages(new Request('http://app/lightscapes/messages', {
        method: 'POST',
        headers: { Authorization: authorizationHeader('hub1', secret) },
        body: JSON.stringify({ messages })
    }));
}

test('a new hub waits for approval, then is welcomed and assigned on the same stream', async () => {
    const store = memoryStore();
    const c = controller(store);
    const { response, abort } = connect(c);
    const res = await response;
    assert.equal(res.status, 200);
    const next = reader(res);
    assert.deepEqual(await next(), { type: 'welcome', result: 'pending', protocol: PROTOCOL_VERSION });
    assert.equal(c.hubs()[0].status, 'pending');
    assert.equal(c.isOnline('hub1'), false);
    assert.equal((await post(c, [])).status, 403);

    c.approve('hub1');
    assert.deepEqual(await next(), { type: 'welcome', result: 'accepted', protocol: PROTOCOL_VERSION });
    assert.equal((await next()).type, 'assign');
    assert.equal(c.isOnline('hub1'), true);
    assert.equal(store.records[0].status, 'approved');
    assert.ok(!('secretHash' in c.hubs()[0]));

    abort.abort();
    c.close();
});

test('an approved hub reports its lights and button presses', async () => {
    const c = controller();
    const first = connect(c);
    await first.response;
    c.approve('hub1');
    const light = { id: 'z2m:lamp', name: 'lamp', kind: 'device', caps: { brightness: true, color: true, effects: [] } };
    const inputs: InputMessage[] = [];
    c.on('input', (_hub, input) => inputs.push(input));
    assert.equal((await post(c, [
        { type: 'inventory', lights: [light], inputs: [] },
        { type: 'state', id: 'z2m:lamp', state: { on: true, brightness: 0.5, reachable: true, source: 'reported' } },
        { type: 'input', device: 'z2m:button', action: 'single', at: 5 }
    ])).status, 204);
    const hub = c.hub('hub1')!;
    assert.deepEqual(hub.inventory?.lights, [light]);
    assert.equal(hub.states['z2m:lamp'].brightness, 0.5);
    assert.equal(inputs[0].action, 'single');
    assert.equal((await post(c, [{ type: 'input' }])).status, 400);
    first.abort.abort();
    c.close();
});

test('a hub with the wrong secret is refused', async () => {
    const c = controller();
    (await connect(c).response).body?.cancel();
    assert.equal((await connect(c, 'other').response).status, 401);
    assert.equal((await post(c, [], 'other')).status, 401);
    c.close();
});

test('a hub on another protocol version is told why', async () => {
    const c = controller();
    const next = reader(await connect(c, 'secret1', hello({ protocol: PROTOCOL_VERSION + 1 })).response);
    const message = await next();
    assert.ok(message.type === 'welcome' && message.result === 'rejected' && /protocol/.test(message.reason ?? ''));
    await assert.rejects(next(), /stream closed/);
});

test('removing a hub tells it, closes its stream and forgets it', async () => {
    const c = controller();
    const next = reader(await connect(c).response);
    await next();
    c.approve('hub1');
    await next();
    await next();
    c.remove('hub1');
    const message = await next();
    assert.ok(message.type === 'welcome' && message.result === 'rejected');
    await assert.rejects(next(), /stream closed/);
    assert.equal(c.hubs().length, 0);
});

test('a reconnect replaces the old stream without taking the hub offline', async () => {
    const c = controller();
    const first = connect(c);
    await first.response;
    c.approve('hub1');
    const second = connect(c);
    await second.response;
    first.abort.abort();
    assert.equal(c.isOnline('hub1'), true);
    second.abort.abort();
    assert.equal(c.isOnline('hub1'), false);
});

test('only so many hubs can wait for approval', async () => {
    const c = new LightscapesController({
        store: memoryStore(),
        assignmentFor: () => ({ following: null, program: { scenes: {}, timelines: {}, fadeSeconds: 1 }, layers: [] }),
        maxPending: 1
    });
    await connect(c).response;
    assert.equal((await connect(c, 's', hello({ hubId: 'hub2' })).response).status, 429);
    c.close();
});
