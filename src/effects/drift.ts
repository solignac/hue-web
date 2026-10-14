import { capabilities } from '../capabilities.js';
import { hexToXy, palettes, samplePalette } from '../color.js';
import { isHueError } from '../errors.js';
import type { Effect } from './engine.js';

/** Options of {@link drift}. */
export interface DriftOptions {
  /** Colours to drift between. Default: ember (warm orange to violet). */
  palette?: readonly string[];
  /** Time each light takes to glide to its next colour. Default 6 s. */
  periodMs?: number;
  /**
   * A native CLIP v2 effect to layer on top, tinted with the drifting colour,
   * on the lights that support it: `candle`, `fire`… Needs v2 (the cloud
   * transport, or a local bridge outside a browser).
   */
  native?: string;
  /** Default 150. */
  brightness?: number;
}

/**
 * Every light glides, on its own, from one colour of the palette to another.
 *
 * A native effect is run by the light itself and outlives our loop. So each
 * light that received it is reset to `no_effect` once the effect stops: stopping
 * a candle drift must not leave candles burning.
 */
export function drift(options: DriftOptions = {}): Effect {
  const palette = options.palette ?? palettes.ember;
  for (const c of palette) hexToXy(c);
  const periodMs = Math.max(1000, options.periodMs ?? 6000);
  const { native } = options;
  return {
    name: native ? `drift (${native})` : 'drift',
    brightness: options.brightness ?? 150,
    async run(ctx) {
      const withNative = new Set<string>();
      let nativeAvailable = !!native;
      ctx.onCleanup(async () => {
        const ids = ctx.lights.filter((l) => withNative.has(l.id) && l.v2Id).map((l) => l.v2Id as string);
        // Batches of 4: fast enough to fit the stop window (one by one, a dozen
        // lights through the cloud overflowed it), without a burst that trips 429.
        for (let i = 0; i < ids.length; i += 4) {
          await Promise.all(
            ids
              .slice(i, i + 4)
              .map((id) => ctx.transport.writeV2(id, { effects: { effect: 'no_effect' } }).catch(() => {})),
          );
        }
      });
      let first = true;
      while (ctx.live()) {
        for (const light of ctx.lights) {
          if (!ctx.live()) break;
          const [x, y] = hexToXy(samplePalette(palette, Math.random()));
          // Colour first, always: it is the fallback wherever the native effect isn't possible.
          await ctx.setLight(light.id, {
            on: true,
            bri: ctx.brightness(),
            xy: [x, y],
            transitiontime: first ? 4 : Math.round(periodMs / 100),
          });
          // Checked again HERE: a stop during the previous command must not start
          // a native effect that would outlive the loop.
          if (
            !native ||
            !nativeAvailable ||
            !ctx.live() ||
            !light.v2Id ||
            !capabilities(light).effects.includes(native)
          )
            continue;
          withNative.add(light.id); // before sending: a lost answer can hide an applied effect
          const body = light.v2?.effects_v2
            ? { effects_v2: { action: { effect: native, parameters: { color: { xy: { x, y } }, speed: 0.5 } } } }
            : { effects: { effect: native } };
          // Best effort, outside the failure count: the colour is already set.
          await ctx.transport.writeV2(light.v2Id, body, { signal: ctx.signal }).catch((e: unknown) => {
            if (isHueError(e, 'unsupported')) nativeAvailable = false;
          });
        }
        first = false;
        await ctx.sleep(periodMs);
      }
    },
  };
}
