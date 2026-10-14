import { describe, expect, it } from 'vitest';
import type { HueLight } from '../src/index.js';
import { capabilities, isControllable, isLit, isPlug, nativeAnimation, parseLights } from '../src/index.js';

const v1 = (raw: Record<string, unknown>): HueLight => {
  const [light] = parseLights({ '1': raw });
  if (!light) throw new Error('unparsed');
  return light;
};

describe('capabilities', () => {
  it('derives v1 capabilities, mindimlevel in thousandths of a percent', () => {
    const light = v1({
      state: { bri: 1, ct: 300, hue: 1, sat: 1 },
      capabilities: { control: { mindimlevel: 200, ct: { min: 153, max: 454 } } },
    });
    expect(capabilities(light)).toEqual({
      dimmable: true,
      minDimPercent: 0.2,
      ct: { min: 153, max: 454 },
      color: true,
      effects: [],
    });
  });

  it('prefers the v2 resource when present', () => {
    const light: HueLight = {
      ...v1({ state: { bri: 1 } }),
      v2Id: 'u',
      v2: {
        dimming: { min_dim_level: 2 },
        color_temperature: { mirek_schema: { mirek_minimum: 160, mirek_maximum: 400 } },
        color: {},
        effects: { status: 'no_effect', effect_values: ['no_effect', 'candle', 'fire'] },
      },
    };
    expect(capabilities(light)).toEqual({
      dimmable: true,
      minDimPercent: 2,
      ct: { min: 160, max: 400 },
      color: true,
      effects: ['candle', 'fire'],
    });
  });

  it('recognises plugs, even when their state looks dimmable', () => {
    const plug = v1({ type: 'On/Off plug-in unit', state: { on: true } });
    expect(isPlug(plug)).toBe(true);
    expect(isControllable(plug)).toBe(false);
    expect(isControllable(v1({ config: { archetype: 'plug' }, state: { bri: 1 } }))).toBe(false);
    expect(isControllable(v1({ state: { on: true } }))).toBe(false);
    expect(isControllable(v1({ state: { ct: 300 } }))).toBe(true);
  });

  it('counts an unpowered light as not lit', () => {
    expect(isLit(v1({ state: { on: true, reachable: false } }))).toBe(false);
    expect(isLit(v1({ state: { on: true } }))).toBe(true);
  });

  it('names what the bridge itself animates', () => {
    const base = v1({ state: { effect: 'none' } });
    expect(nativeAnimation(base)).toBeNull();
    expect(nativeAnimation(v1({ state: { effect: 'colorloop' } }))).toBe('colorloop');
    expect(nativeAnimation({ ...base, v2: { effects: { status: 'fire' } } })).toBe('fire');
    expect(nativeAnimation({ ...base, v2: { timed_effects: { status: 'sunrise' } } })).toBe('sunrise');
    expect(nativeAnimation({ ...base, v2: { mode: 'streaming' } })).toBe('streaming');
  });
});
