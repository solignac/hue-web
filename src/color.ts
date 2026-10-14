/**
 * Colour conversions between CSS hex and what the Hue API speaks: CIE xy
 * (v1 `xy`, v2 `color.xy`), hue/saturation (v1 `hue`/`sat`) and mirek (`ct`).
 * Brightness is never derived from a colour: picking a colour must not light a
 * dimmed lamp at full power.
 */

type Rgb = readonly [number, number, number];

/** `#rgb` / `#rrggbb` (with or without `#`) → channels in 0–1. */
function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) throw new TypeError(`Invalid hex colour: ${JSON.stringify(hex)}`);
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const n = Number.parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Hex → CIE 1931 xy (sRGB gamma removed, Wide RGB D65), as Philips documents it. */
export function hexToXy(hex: string): [number, number] {
  const linear = (c: number): number => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92);
  const [r, g, b] = parseHex(hex).map(linear) as unknown as Rgb;
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const sum = X + Y + Z;
  if (sum === 0) return [0.3127, 0.329]; // black has no chromaticity: D65 white
  return [round4(X / sum), round4(Y / sum)];
}

/** CIE xy → hex at full luminance, for display. */
export function xyToHex(x: number, y: number): string {
  if (y <= 0) return '#ffffff';
  const X = x / y;
  const Z = (1 - x - y) / y;
  const rgb: Rgb = [
    X * 3.2406 - 1.5372 - Z * 0.4986,
    -X * 0.9689 + 1.8758 + Z * 0.0415,
    X * 0.0557 - 0.204 + Z * 1.057,
  ];
  const max = Math.max(...rgb, 1);
  const gamma = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  const [r, g, b] = rgb.map((c) => gamma(Math.max(0, c) / max)) as unknown as Rgb;
  return toHex(r, g, b);
}

/** Hex → v1 `{ hue: 0–65535, sat: 0–254 }`. */
export function hexToHueSat(hex: string): { hue: number; sat: number } {
  const [r, g, b] = parseHex(hex);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { hue: Math.round((h / 6) * 65535), sat: Math.round((max === 0 ? 0 : d / max) * 254) };
}

/** v1 hue/sat → hex at full value, for display. */
export function hueSatToHex(hue: number, sat: number): string {
  return hsvToHex((hue / 65535) * 360, sat / 254, 1);
}

/** Mirek → an approximate display colour (153 cold blue-white … 500 warm amber). */
export function mirekToHex(mirek: number): string {
  const t = Math.min(1, Math.max(0, (mirek - 153) / (500 - 153)));
  return toHex((214 + 41 * t) / 255, (234 - 68 * t) / 255, (255 - 168 * t) / 255);
}

/** HSV (degrees, 0–1, 0–1) → hex. */
export function hsvToHex(h: number, s: number, v: number): string {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  return toHex(r + m, g + m, b + m);
}

/**
 * Samples a looping palette: `t` 0 → first colour, 1 → back to the first,
 * linear in between. Any real `t` works, so effects can scroll through it.
 */
export function samplePalette(palette: readonly string[], t: number): string {
  if (palette.length === 0) throw new TypeError('A palette needs at least one colour.');
  const n = palette.length;
  const x = (((t % 1) + 1) % 1) * n;
  const i = Math.floor(x) % n;
  const a = parseHex(palette[i] as string);
  const b = parseHex(palette[(i + 1) % n] as string);
  const f = x - Math.floor(x);
  return toHex(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

/** Ready-made looping palettes for the built-in effects. */
export const palettes: Readonly<Record<'rainbow' | 'sunset' | 'ocean' | 'aurora' | 'ember', readonly string[]>> = {
  rainbow: ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff'],
  sunset: ['#ff3b30', '#ff8a00', '#ffd400', '#9b4dff'],
  ocean: ['#00e0d5', '#2e6bff', '#0a2a6b', '#00a3e0'],
  aurora: ['#34c759', '#00e0d5', '#2e6bff', '#9b4dff'],
  ember: ['#ff7a18', '#ff4f6d', '#c24de0', '#7b5cff'],
};

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
