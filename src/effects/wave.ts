import { hexToXy, palettes, samplePalette } from '../color.js';
import { now } from '../internal/async.js';
import type { Effect } from './engine.js';

/** Options of {@link wave}. */
export interface WaveOptions {
  /** Looping palette (hex colours). Default: rainbow. */
  palette?: readonly string[];
  /** Time for the palette to scroll one full turn. Default 12 s. */
  cycleMs?: number;
  /**
   * Where each light sits along the wave, 0–1 (by light id), e.g. from its
   * position in the room. Default: the order of the lights.
   */
  offsets?: Readonly<Record<string, number>>;
  /** Default 200. */
  brightness?: number;
}

/**
 * A palette scrolling across the lights. Each command asks the bridge to FADE to
 * the target over about the time until that light's next update: the bridge
 * interpolates, so the wave looks smooth with only a few commands per second,
 * locally or through the cloud.
 */
export function wave(options: WaveOptions = {}): Effect {
  const palette = options.palette ?? palettes.rainbow;
  for (const c of palette) hexToXy(c); // fail fast on a bad colour
  const cycleMs = Math.max(500, options.cycleMs ?? 12_000);
  return {
    name: 'wave',
    brightness: options.brightness ?? 200,
    async run(ctx) {
      const n = ctx.lights.length;
      const order = ctx.lights
        .map((light, i) => ({ light, offset: options.offsets?.[light.id] ?? i / n }))
        .sort((a, b) => a.offset - b.offset);
      const lastAt = new Map<string, number>();
      const t0 = now();
      while (ctx.live()) {
        for (const { light, offset } of order) {
          if (!ctx.live()) break;
          const t = now();
          const xy = hexToXy(samplePalette(palette, offset - (t - t0) / cycleMs));
          const previous = lastAt.get(light.id);
          lastAt.set(light.id, t);
          // First pass: a short fade, so the room takes the effect at once.
          const transitiontime =
            previous === undefined ? 4 : Math.min(40, Math.max(2, Math.round((t - previous) / 100)));
          await ctx.setLight(light.id, { on: true, bri: ctx.brightness(), xy, transitiontime });
        }
      }
    },
  };
}
