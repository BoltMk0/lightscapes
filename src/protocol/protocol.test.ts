import { test } from "node:test";
import assert from "node:assert/strict";
import { ProtocolError, authorizationHeader, checkAppMessage, checkHello, checkHubMessage, parseAuthorization, type AppMessage } from "./index.ts";

const assign: AppMessage = {
    type: 'assign',
    following: { id: 'game-1', name: 'Tuesday game' },
    program: {
        scenes: { night: { entries: [{ target: 'z2m:lamp', light: { on: true, brightness: 0.2, color: { kind: 'white', kelvin: 2200 } } }] } },
        timelines: { sky: { stops: [{ at: 0, color: { kind: 'rgb', hex: '#88aaff' }, brightness: 0.6 }], stepSeconds: 10 } },
        fadeSeconds: 2
    },
    layers: [
        { id: 'phase', priority: 0, scene: 'night' },
        { id: 'override', priority: 100, scene: { entries: [] }, fadeSeconds: 0.5, clock: { kind: 'running', startedAt: 1, durationMs: 1000, cap: 0.99 } }
    ]
};

test('a valid message comes back as it was sent', () => {
    assert.deepEqual(checkAppMessage(JSON.parse(JSON.stringify(assign))), assign);
    const input = { type: 'input', device: 'z2m:button', action: 'single', at: 5 };
    assert.deepEqual(checkHubMessage(input), input);
});

test('a timeline\'s stops are sorted', () => {
    const message = checkAppMessage({
        type: 'program',
        program: { scenes: {}, fadeSeconds: 1, timelines: { t: { stepSeconds: 5, stops: [
            { at: 1, color: { kind: 'white', kelvin: 2000 }, brightness: 1 },
            { at: 0, color: { kind: 'white', kelvin: 6000 }, brightness: 1 }
        ] } } }
    });
    assert.ok(message.type === 'program');
    assert.deepEqual(message.program.timelines.t.stops.map(s => s.at), [0, 1]);
});

test('a bad message says what is wrong', () => {
    assert.throws(() => checkAppMessage({ type: 'layers', layers: [{ id: 'x', priority: 0, scene: { entries: [{ target: 'a', light: { on: true, brightness: 2 } }] } }] }),
        (err: unknown) => err instanceof ProtocolError && /brightness/.test(err.message));
    assert.throws(() => checkHubMessage({ type: 'nonsense' }), ProtocolError);
    assert.throws(() => checkHello({ type: 'hello', hubId: '', name: 'x', hubVersion: '1', protocol: 1, adapters: [] }), ProtocolError);
});

test('the authorization header carries the hub id and secret', () => {
    assert.deepEqual(parseAuthorization(authorizationHeader('hub_1', 'abc-DEF')), { hubId: 'hub_1', secret: 'abc-DEF' });
    assert.equal(parseAuthorization('Bearer nodot'), null);
    assert.equal(parseAuthorization(undefined), null);
});
