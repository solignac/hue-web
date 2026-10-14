import { describe, expect, it } from 'vitest';
import {
  firstError,
  mergeV2,
  parseBridgeInfo,
  parseGroups,
  parseLights,
  parseScenes,
  type V1Error,
} from '../src/index.js';

describe('parsers', () => {
  it('normalises v1 lights, sorted by numeric id, without undefined fields', () => {
    const lights = parseLights({
      '10': { name: 'Ten', state: { on: true, bri: 5, reachable: true } },
      '2': {
        name: 'Two',
        type: 'Extended color light',
        productname: 'Hue color lamp',
        state: { on: false, bri: 100, hue: 10, sat: 20, ct: 300, colormode: 'hs', reachable: false },
        capabilities: { control: { mindimlevel: 200, ct: { min: 153, max: 454 }, colorgamuttype: 'C' } },
        config: { archetype: 'sultanbulb' },
      },
      bogus: 42,
    });
    expect(lights.map((l) => l.id)).toEqual(['2', '10']);
    expect(lights[0]).toEqual({
      id: '2',
      name: 'Two',
      on: false,
      reachable: false,
      bri: 100,
      hue: 10,
      sat: 20,
      ct: 300,
      colormode: 'hs',
      product: {
        type: 'Extended color light',
        name: 'Hue color lamp',
        archetype: 'sultanbulb',
        gamut: 'C',
        ctRange: [153, 454],
        minDimLevel: 200,
      },
    });
    expect(Object.keys(lights[1] ?? {})).not.toContain('hue');
  });

  it('keeps only rooms and zones', () => {
    const groups = parseGroups({
      '1': { name: 'Living', type: 'Room', class: 'Living room', lights: ['1', 2, '3'] },
      '2': { name: 'Entertainment', type: 'Entertainment', lights: ['1'] },
      '3': { type: 'Zone' },
    });
    expect(groups).toEqual([
      { id: '1', name: 'Living', type: 'Room', class: 'Living room', lightIds: ['1', '3'] },
      { id: '3', name: 'Group 3', type: 'Zone', lightIds: [] },
    ]);
  });

  it('parses scenes with their group', () => {
    expect(parseScenes({ a: { name: 'Relax', group: '1' }, b: {} })).toEqual([
      { id: 'a', name: 'Relax', groupId: '1' },
      { id: 'b', name: 'Scene b' },
    ]);
  });

  it('reads the bridge id in lower case and only a valid IPv4', () => {
    expect(parseBridgeInfo({ bridgeid: 'ECB5FAFFFE0A1B2C', ipaddress: '192.168.1.20' })).toEqual({
      id: 'ecb5fafffe0a1b2c',
      ip: '192.168.1.20',
    });
    expect(parseBridgeInfo({ ipaddress: '999.1.1.1' })).toEqual({ id: null, ip: null });
    expect(parseBridgeInfo(null)).toEqual({ id: null, ip: null });
  });

  it('attaches v2 resources by id_v1', () => {
    const [a, b] = mergeV2(parseLights({ '1': { state: {} }, '2': { state: {} } }), [
      { id: 'uuid-1', id_v1: '/lights/1', effects: { status: 'candle' } },
      { id: 'uuid-x', id_v1: '/groups/2' },
    ]);
    expect(a?.v2Id).toBe('uuid-1');
    expect(a?.v2).toMatchObject({ effects: { status: 'candle' } });
    expect(b?.v2Id).toBeUndefined();
  });

  it('treats a v1 answer as failed only when nothing applied', () => {
    const refused: V1Error = { type: 1, description: 'unauthorized user' };
    expect(firstError([{ error: { type: 1, description: 'unauthorized user' } }])).toEqual(refused);
    expect(
      firstError([
        { success: { '/lights/1/state/on': true } },
        { error: { type: 6, description: 'hue not available' } },
      ]),
    ).toBeNull();
    expect(firstError({ '1': {} })).toBeNull();
  });
});
