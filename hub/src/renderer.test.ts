import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Layer, LightInfo, Program } from "../../src/protocol/index.ts";
import type { Adapter, ResolvedState } from "./adapters/adapter.ts";
import { Renderer, clockPosition, fitToLight } from "./renderer.ts";

const caps = { brightness: true, color: true, white: { minKelvin: 2000, maxKelvin: 6500 }, effects: [] };

class FakeAdapter extends EventEmitter {
    readonly id = 'fake';
    readonly name = 'Fake';
    readonly limits = { messagesPerSecond: 100, nativeFade: true, nativeGroups: true };
    sent: { id: string; state: ResolvedState; fade: number }[] = [];
    lightList: LightInfo[] = ['fake:a', 'fake:b'].map(id => ({ id, name: id, kind: 'device', caps }));
    health() { return { id: this.id, name: this.name, ok: true }; }
    lights() { return this.lightList; }
    inputs() { return []; }
    states() { return {}; }
    set(id: string, state: ResolvedState, fade: number) { this.sent.push({ id, state, fade }); }
    refreshStates() {}
    close() {}
    take() { const sent = this.sent; this.sent = []; return sent; }
}

function setup(program: Partial<Program> = {}) {
    const adapter = new FakeAdapter();
    let now = 1_000_000;
    const time = { now: () => now };
    const renderer = new Renderer([adapter as unknown as Adapter], time, () => {});
    renderer.assign({ scenes: {}, timelines: {}, fadeSeconds: 2, ...program }, []);
    return { adapter, renderer, advance: (ms: number) => { now += ms; mock.timers.tick(ms); }, now: () => now };
}

const scene = (entries: [string, object][]) => ({ entries: entries.map(([target, light]) => ({ target, light: light as never })) });

test('the highest-priority layer naming a light wins, and nothing unchanged is sent again', () => {
    const { adapter, renderer } = setup({
        scenes: {
            night: scene([['fake:a', { on: true, brightness: 0.2 }], ['fake:b', { on: false }]]),
            bright: scene([['fake:a', { on: true, brightness: 1 }]])
        }
    });
    renderer.setLayers([{ id: 'phase', priority: 0, scene: 'night' }]);
    assert.deepEqual(adapter.take().map(s => [s.id, s.state, s.fade]), [
        ['fake:a', { on: true, brightness: 0.2 }, 2],
        ['fake:b', { on: false }, 2]
    ]);
    renderer.setLayers([{ id: 'phase', priority: 0, scene: 'night' }, { id: 'top', priority: 10, scene: 'bright', fadeSeconds: 0.5 }]);
    assert.deepEqual(adapter.take().map(s => [s.id, s.state.brightness, s.fade]), [['fake:a', 1, 0.5]]);
    // The top layer gone: back to the phase's, at the phase's fade
    renderer.setLayers([{ id: 'phase', priority: 0, scene: 'night' }]);
    assert.deepEqual(adapter.take().map(s => [s.id, s.state.brightness, s.fade]), [['fake:a', 0.2, 2]]);
    renderer.setLayers([{ id: 'phase', priority: 0, scene: 'night' }]);
    assert.equal(adapter.take().length, 0);
});

test('a cue flashes its lights, holds, then fades back at its own fade', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const { adapter, renderer, advance } = setup({ scenes: { day: scene([['fake:a', { on: true, brightness: 0.5 }]]) } });
        renderer.setLayers([{ id: 'phase', priority: 0, scene: 'day' }]);
        adapter.take();
        renderer.cue({ id: 'bell', priority: 50, scene: scene([['fake:a', { on: true, brightness: 1, effect: 'blink' }]]), fadeSeconds: 1, holdSeconds: 2 });
        assert.deepEqual(adapter.take().map(s => [s.state.brightness, s.state.effect, s.fade]), [[1, 'blink', 1]]);
        advance(2999);
        assert.equal(adapter.take().length, 0);
        advance(1);
        assert.deepEqual(adapter.take().map(s => [s.state.brightness, s.fade]), [[0.5, 1]]);
    } finally {
        mock.timers.reset();
    }
});

test('a cue can start later, in the app\'s time', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const { adapter, renderer, advance, now } = setup();
        renderer.cue({ id: 'reminder', priority: 50, scene: scene([['fake:a', { on: true }]]), holdSeconds: 1 }, now() + 5000);
        assert.equal(adapter.take().length, 0);
        advance(5000);
        assert.equal(adapter.take().length, 1);
    } finally {
        mock.timers.reset();
    }
});

test('lights following a timeline move along it as the clock runs, and stop at its cap', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const { adapter, renderer, advance, now } = setup({
            timelines: { sky: { stepSeconds: 10, stops: [
                { at: 0, color: { kind: 'white', kelvin: 6000 }, brightness: 1 },
                { at: 1, color: { kind: 'white', kelvin: 2000 }, brightness: 0.5 }
            ] } },
            scenes: { day: scene([['fake:a', { on: true, color: { kind: 'timeline', id: 'sky' } }], ['fake:b', { on: true, brightness: 0.5, color: { kind: 'timeline', id: 'sky' } }]]) }
        });
        const layer: Layer = { id: 'phase', priority: 0, scene: 'day', clock: { kind: 'running', startedAt: now(), durationMs: 100_000, cap: 0.99 } };
        renderer.setLayers([layer]);
        const first = adapter.take();
        assert.deepEqual(first.map(s => [s.id, s.state.brightness, s.fade]), [['fake:a', 1, 2], ['fake:b', 0.5, 2]]);
        // Joining at the layer's fade, then moving along: each step aims at where it'll be when its fade ends
        advance(2000);
        const step = adapter.take();
        assert.equal(step.length, 2);
        assert.equal(step[0].fade, 10);
        assert.ok(Math.abs(step[0].state.brightness! - (1 - 0.5 * 0.12)) < 1e-9);
        assert.ok(Math.abs(step[1].state.brightness! - 0.5 * (1 - 0.5 * 0.12)) < 1e-9);
        // Past the cap it holds there, and stops stepping
        advance(120_000);
        adapter.take();
        advance(60_000);
        assert.equal(adapter.take().length, 0);
    } finally {
        mock.timers.reset();
    }
});

test('a clock\'s position', () => {
    assert.equal(clockPosition(undefined, 5), 0);
    assert.equal(clockPosition({ kind: 'fixed', position: 0.3 }, 5), 0.3);
    assert.equal(clockPosition({ kind: 'running', startedAt: 0, durationMs: 100 }, 50), 0.5);
    assert.equal(clockPosition({ kind: 'running', startedAt: 0, durationMs: 100, cap: 0.9 }, 95), 0.9);
    assert.equal(clockPosition({ kind: 'running', startedAt: 0, durationMs: 100, cap: 0.9 }, 100), 1);
    assert.equal(clockPosition({ kind: 'running', startedAt: 100, durationMs: 100 }, 50), 0);
});

test('a white goes as a colour to a light that only does colours, and a colour as a white to one that only does whites', () => {
    const colourOnly: LightInfo = { id: 'x', name: 'x', kind: 'device', caps: { brightness: true, color: true, effects: [] } };
    const whiteOnly: LightInfo = { id: 'y', name: 'y', kind: 'device', caps: { brightness: true, color: false, white: { minKelvin: 2200, maxKelvin: 4000 }, effects: [] } };
    assert.equal(fitToLight({ on: true, color: { kind: 'white', kelvin: 2700 } }, colourOnly).color?.kind, 'rgb');
    const white = fitToLight({ on: true, color: { kind: 'rgb', hex: '#0000ff' } }, whiteOnly).color;
    assert.deepEqual(white, { kind: 'white', kelvin: 4000 });
});
