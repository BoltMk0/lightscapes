// Colour maths shared by hubs and apps: whites (colour temperatures) and the colours they show as, and where a timeline
// is at any point. Plain functions with no Node or DOM use, so a browser page can use them too.

import type { Timeline, TimelineColor, TimelineStop } from "../protocol/index.ts";

/** The warmest and coolest whites most bulbs do, in mireds (about 2000K to 6500K). */
export const WARMEST_MIREDS = 500;
export const COOLEST_MIREDS = 153;
export const WARMEST_KELVIN = 2000;
export const COOLEST_KELVIN = 6500;

export function kelvinToMireds(kelvin: number): number {
    return 1_000_000 / kelvin;
}

export function miredsToKelvin(mireds: number): number {
    return 1_000_000 / mireds;
}

export type Rgb = { r: number; g: number; b: number };

export function hexToRgb(hex: string): Rgb {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
    return '#' + [r, g, b].map(c => Math.min(255, Math.max(0, Math.round(c))).toString(16).padStart(2, '0')).join('');
}

/** The white a black body glows at `mireds`, as CIE xy (Kim et al.'s fit to the Planckian locus). */
function planckXy(mireds: number): { x: number; y: number } {
    const k = 1_000_000 / mireds;
    const x = k <= 4000
        ? -0.2661239e9 / k ** 3 - 0.2343589e6 / k ** 2 + 0.8776956e3 / k + 0.179910
        : -3.0258469e9 / k ** 3 + 2.1070379e6 / k ** 2 + 0.2226347e3 / k + 0.240390;
    const y = k <= 2222 ? -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683
        : k <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
        : 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483;
    return { x, y };
}

/** CIE 1960 uv, where distances from the Planckian locus are measured. */
function xyToUv({ x, y }: { x: number; y: number }): { u: number; v: number } {
    const d = -2 * x + 12 * y + 3;
    return { u: 4 * x / d, v: 6 * y / d };
}

const toLinear = (c: number) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const fromLinear = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

const LOCUS: { mireds: number; u: number; v: number }[] = [];
for(let mireds = COOLEST_MIREDS; mireds <= WARMEST_MIREDS; mireds++) LOCUS.push({ mireds, ...xyToUv(planckXy(mireds)) });

/** The colour temperature (in mireds) nearest a colour like #ffaa00: blues go to the coolest white, oranges warm. */
export function hexToMireds(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    const r = toLinear((n >> 16) & 255), g = toLinear((n >> 8) & 255), b = toLinear(n & 255);
    const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
    const d = X + 15 * Y + 3 * Z;
    // Black has no hue; it's dimmed by its brightness anyway
    if(d === 0) return WARMEST_MIREDS;
    const u = 4 * X / d, v = 6 * Y / d;
    let best = LOCUS[0];
    for(const point of LOCUS){
        if((point.u - u) ** 2 + (point.v - v) ** 2 < (best.u - u) ** 2 + (best.v - v) ** 2) best = point;
    }
    return best.mireds;
}

/** The colour a white of `mireds` shows as, at full brightness, like #ffaa00. */
export function miredsToHex(mireds: number): string {
    const { x, y } = planckXy(mireds);
    const X = x / y, Z = (1 - x - y) / y;
    const rgb = [
        3.2406 * X - 1.5372 - 0.4986 * Z,
        -0.9689 * X + 1.8758 + 0.0415 * Z,
        0.0557 * X - 0.2040 + 1.0570 * Z
    ].map(c => Math.max(c, 0));
    const max = Math.max(...rgb);
    return '#' + rgb.map(c => Math.round(fromLinear(c / max)).toString(16).padStart(2, '0')).join('');
}

/** The white (in kelvin) nearest a colour like #ffaa00. */
export function hexToKelvin(hex: string): number {
    return Math.round(miredsToKelvin(hexToMireds(hex)));
}

/** The colour a white of `kelvin` shows as, at full brightness, like #ffaa00. */
export function kelvinToHex(kelvin: number): string {
    return miredsToHex(kelvinToMireds(kelvin));
}

/** The colour a timeline colour shows as, like #ffaa00: its white's, if it's white. */
export function shownHex(color: TimelineColor): string {
    return color.kind === 'white' ? kelvinToHex(color.kelvin) : color.hex;
}

/** Where a timeline is: the colour (a white or a colour) and its brightness, 0-1. */
export type TimelinePoint = { color: TimelineColor; brightness: number };

/**
 * The colour and brightness `progress` (0-1) of the way along the stops, between the stops either side of it. Between
 * two whites it fades by colour temperature, on the bulbs' white light; next to a colour, it fades in colour, from or
 * to the white's.
 */
export function timelineAt(stops: readonly TimelineStop[], progress: number): TimelinePoint {
    if(stops.length === 0) throw new Error('A timeline needs at least one stop');
    const p = Math.min(Math.max(progress, 0), 1);
    if(p <= stops[0].at) return { color: stops[0].color, brightness: stops[0].brightness };
    const last = stops[stops.length - 1];
    if(p >= last.at) return { color: last.color, brightness: last.brightness };

    let i = 0;
    while(p > stops[i + 1].at) i++;
    const lower = stops[i];
    const upper = stops[i + 1];
    const t = upper.at === lower.at ? 1 : (p - lower.at) / (upper.at - lower.at);
    const brightness = lower.brightness + (upper.brightness - lower.brightness) * t;
    if(lower.color.kind === 'white' && upper.color.kind === 'white'){
        // By mireds, which is how even a fade between whites looks
        const a = kelvinToMireds(lower.color.kelvin), b = kelvinToMireds(upper.color.kelvin);
        return { color: { kind: 'white', kelvin: miredsToKelvin(a + (b - a) * t) }, brightness };
    }
    const a = hexToRgb(shownHex(lower.color));
    const b = hexToRgb(shownHex(upper.color));
    return {
        color: { kind: 'rgb', hex: rgbToHex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }) },
        brightness
    };
}

/** The stops of a timeline, sorted by where they are. */
export function sortedStops(timeline: Timeline): TimelineStop[] {
    return [...timeline.stops].sort((a, b) => a.at - b.at);
}
