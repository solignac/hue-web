import type { HueLight } from './types.js';

/** What a light can actually do. Every capability comes from what the light declares. */
export interface LightCapabilities {
  /** Brightness can be set. */
  readonly dimmable: boolean;
  /** Lowest brightness the light can render, in percent. */
  readonly minDimPercent: number;
  /** Colour temperature range in mirek, or `null` for lights without tunable white. */
  readonly ct: { readonly min: number; readonly max: number } | null;
  /** Full colour (xy or hue/saturation), not only white. */
  readonly color: boolean;
  /** Native CLIP v2 effects (`candle`, `fire`, `prism`…). Empty when v2 isn't served. */
  readonly effects: readonly string[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' ? (v as Json) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/**
 * What `light` can do. Its CLIP v2 resource is the source of truth when the
 * transport serves one; otherwise its v1 state and capabilities are read, and
 * what neither says falls back on the Hue defaults (1 % minimum, 153–500 mirek).
 */
export function capabilities(light: HueLight): LightCapabilities {
  const v2 = obj(light.v2);
  const ctResource = obj(v2?.color_temperature);
  const schema = obj(ctResource?.mirek_schema);
  const hasCt = v2 ? !!ctResource : light.ct !== undefined;
  const dimming = obj(v2?.dimming);
  const fx = obj(v2?.effects);
  const values = Array.isArray(fx?.effect_values)
    ? fx.effect_values
    : Array.isArray(fx?.status_values)
      ? fx.status_values
      : [];
  // v1 `mindimlevel` is in thousandths of a percent (200 → 0.2 %), v2 in percent.
  const v1MinDim = light.product.minDimLevel === undefined ? undefined : light.product.minDimLevel / 1000;
  return {
    dimmable: v2 ? !!dimming : light.bri !== undefined,
    minDimPercent: num(dimming?.min_dim_level) ?? v1MinDim ?? 1,
    ct: hasCt
      ? {
          min: num(schema?.mirek_minimum) ?? light.product.ctRange?.[0] ?? 153,
          max: num(schema?.mirek_maximum) ?? light.product.ctRange?.[1] ?? 500,
        }
      : null,
    color: v2 ? !!obj(v2.color) : light.hue !== undefined && light.sat !== undefined,
    effects: values.filter((e): e is string => typeof e === 'string' && e !== 'no_effect'),
  };
}

/** A smart plug drives an unknown load: effects and ambiances should leave it alone. */
export function isPlug(light: HueLight): boolean {
  const hay = `${light.product.archetype ?? ''} ${light.product.name ?? ''} ${light.product.type ?? ''}`.toLowerCase();
  return /\bplug\b|plug-in/.test(hay);
}

/**
 * A light whose colour or brightness can be driven. Plugs are excluded twice:
 * by name, and because their state has none of bri/ct/hue.
 */
export function isControllable(light: HueLight): boolean {
  if (isPlug(light)) return false;
  return light.bri !== undefined || light.ct !== undefined || (light.hue !== undefined && light.sat !== undefined);
}

/** Actually emitting light: on AND powered. */
export function isLit(light: HueLight): boolean {
  return light.on && light.reachable;
}

/**
 * The animation the bridge itself is running on this light (a native v2 effect,
 * a timed effect such as sunrise, v1 `colorloop`, Entertainment streaming), or
 * `null`.
 */
export function nativeAnimation(light: HueLight): string | null {
  const v2 = obj(light.v2);
  if (v2?.mode === 'streaming') return 'streaming';
  for (const key of ['timed_effects', 'effects'] as const) {
    const status = obj(v2?.[key])?.status;
    if (typeof status === 'string' && status !== 'no_effect') return status;
  }
  if (light.effect === 'colorloop') return 'colorloop';
  return null;
}
