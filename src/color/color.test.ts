import { test } from "node:test";
import assert from "node:assert/strict";
import { hexToKelvin, hexToMireds, kelvinToHex, miredsToHex, timelineAt } from "./index.ts";
import type { TimelineStop } from "../protocol/index.ts";

// From the hub page's whites.js before it moved here, so the lights and remotes show the same whites as before
const MIREDS_TO_HEX: Record<number, string> = {"153":"#fff9ff","184":"#ffecdf","215":"#ffe0c2","246":"#ffd5a8","277":"#ffca91","308":"#ffc07d","339":"#ffb66a","370":"#ffad59","401":"#ffa449","432":"#ff9c3a","463":"#ff942b","494":"#ff8c1a"};
const HEX_TO_MIREDS: Record<string, number> = {"#ff0000":500,"#00ff00":165,"#0000ff":153,"#ffaa00":399,"#ffffff":154,"#000000":500,"#87ceeb":153,"#ff8c42":482};

test('whites are as they were in whites.js', () => {
    for(const [mireds, hex] of Object.entries(MIREDS_TO_HEX)) assert.equal(miredsToHex(Number(mireds)), hex);
    for(const [hex, mireds] of Object.entries(HEX_TO_MIREDS)) assert.equal(hexToMireds(hex), mireds, hex);
});

test('kelvin round-trips through its colour', () => {
    for(const kelvin of [2200, 2700, 3500, 4500, 6000]) assert.ok(Math.abs(hexToKelvin(kelvinToHex(kelvin)) - kelvin) < 60, String(kelvin));
});

const white = (at: number, kelvin: number, brightness: number): TimelineStop => ({ at, color: { kind: 'white', kelvin }, brightness });
const rgb = (at: number, hex: string, brightness: number): TimelineStop => ({ at, color: { kind: 'rgb', hex }, brightness });

test('a timeline holds its first and last stops beyond them', () => {
    const stops = [white(0.2, 4000, 0.5), white(0.8, 2500, 1)];
    assert.deepEqual(timelineAt(stops, 0), { color: { kind: 'white', kelvin: 4000 }, brightness: 0.5 });
    assert.deepEqual(timelineAt(stops, 1), { color: { kind: 'white', kelvin: 2500 }, brightness: 1 });
});

test('between two whites a timeline fades by temperature, evenly in mireds', () => {
    const point = timelineAt([white(0, 2000, 0), white(1, 5000, 1)], 0.5);
    assert.equal(point.color.kind, 'white');
    // 500 and 200 mireds: halfway is 350, about 2857K
    assert.ok(point.color.kind === 'white' && Math.abs(point.color.kelvin - 1_000_000 / 350) < 0.001);
    assert.equal(point.brightness, 0.5);
});

test('next to a colour a timeline fades in colour, from the white\'s', () => {
    const point = timelineAt([rgb(0, '#000000', 1), rgb(1, '#ff8000', 1)], 0.5);
    assert.deepEqual(point.color, { kind: 'rgb', hex: '#804000' });
    const mixed = timelineAt([white(0, 2700, 1), rgb(1, '#0000ff', 1)], 0);
    assert.equal(mixed.color.kind, 'white');
    assert.equal(timelineAt([white(0, 2700, 1), rgb(1, '#0000ff', 1)], 0.5).color.kind, 'rgb');
});
