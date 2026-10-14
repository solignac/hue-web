import { describe, expect, it } from 'vitest';
import { hexToHueSat, hexToXy, hueSatToHex, mirekToHex, palettes, samplePalette, xyToHex } from '../src/index.js';

const expectXy = (actual: [number, number], expected: [number, number]): void => {
  expect(actual[0]).toBeCloseTo(expected[0], 3);
  expect(actual[1]).toBeCloseTo(expected[1], 3);
};
const channels = (hex: string): number[] => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

describe('colour conversions', () => {
  it('converts sRGB primaries to their CIE xy coordinates', () => {
    expectXy(hexToXy('#ff0000'), [0.64, 0.33]);
    expectXy(hexToXy('#00ff00'), [0.3, 0.6]);
    expectXy(hexToXy('#0000ff'), [0.15, 0.06]);
    expectXy(hexToXy('#ffffff'), [0.3127, 0.329]);
  });

  it('gives black the D65 white point instead of NaN', () => {
    expect(hexToXy('#000000')).toEqual([0.3127, 0.329]);
  });

  it('accepts short and hash-less hex, rejects anything else', () => {
    expect(hexToXy('f00')).toEqual(hexToXy('#ff0000'));
    expect(() => hexToXy('red')).toThrow(TypeError);
    expect(() => hexToXy('#12345')).toThrow(TypeError);
  });

  it('round-trips xy for saturated colours, within a unit per channel', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ff00ff', '#ff8000']) {
      const [x, y] = hexToXy(hex);
      const back = channels(xyToHex(x, y));
      for (const [i, c] of channels(hex).entries()) expect(Math.abs(c - (back[i] ?? -9))).toBeLessThanOrEqual(1);
    }
  });

  it('maps hue/sat both ways', () => {
    expect(hexToHueSat('#ff0000')).toEqual({ hue: 0, sat: 254 });
    expect(hexToHueSat('#00ffff')).toEqual({ hue: 32768, sat: 254 });
    expect(hexToHueSat('#ffffff')).toEqual({ hue: 0, sat: 0 });
    expect(hueSatToHex(21845, 254)).toBe('#00ff00');
  });

  it('ramps mirek from cold to warm and clamps', () => {
    expect(mirekToHex(153)).toBe('#d6eaff');
    expect(mirekToHex(500)).toBe('#ffa657');
    expect(mirekToHex(1000)).toBe(mirekToHex(500));
  });

  it('samples a looping palette', () => {
    const p = ['#000000', '#ffffff'];
    expect(samplePalette(p, 0)).toBe('#000000');
    expect(samplePalette(p, 0.25)).toBe('#808080');
    expect(samplePalette(p, 0.5)).toBe('#ffffff');
    expect(samplePalette(p, 1)).toBe('#000000');
    expect(samplePalette(p, -0.5)).toBe('#ffffff');
    expect(() => samplePalette([], 0)).toThrow(TypeError);
    for (const palette of Object.values(palettes)) for (const c of palette) expect(() => hexToXy(c)).not.toThrow();
  });
});
