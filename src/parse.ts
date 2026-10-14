import type { BridgeInfo, HueGroup, HueLight, HueScene, LightProduct } from './types.js';

/**
 * Pure parsers shared by every transport, so local and cloud normalise the
 * bridge's answers exactly the same way.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Drops `undefined` values, so optional fields are absent rather than `undefined`. */
function compact<T extends object>(o: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** v1 `/lights` (an object keyed by id) → lights, sorted by id. */
export function parseLights(data: unknown): HueLight[] {
  if (!isObject(data)) return [];
  const lights: HueLight[] = [];
  for (const [id, raw] of Object.entries(data)) {
    if (!isObject(raw)) continue;
    const state = isObject(raw.state) ? raw.state : {};
    const control = isObject(raw.capabilities) && isObject(raw.capabilities.control) ? raw.capabilities.control : {};
    const ct = isObject(control.ct) ? control.ct : {};
    const ctMin = num(ct.min);
    const ctMax = num(ct.max);
    const hue = num(state.hue);
    const sat = num(state.sat);
    const hasColor = hue !== undefined && sat !== undefined;
    const product = compact<LightProduct>({
      type: str(raw.type),
      modelId: str(raw.modelid),
      name: str(raw.productname),
      manufacturer: str(raw.manufacturername),
      archetype: isObject(raw.config) ? str(raw.config.archetype) : undefined,
      gamut: str(control.colorgamuttype),
      ctRange: ctMin !== undefined && ctMax !== undefined ? ([ctMin, ctMax] as const) : undefined,
      minDimLevel: num(control.mindimlevel),
    });
    lights.push(
      compact<HueLight>({
        id,
        name: str(raw.name) || `Light ${id}`,
        on: state.on === true,
        reachable: state.reachable !== false,
        bri: num(state.bri),
        hue: hasColor ? hue : undefined,
        sat: hasColor ? sat : undefined,
        ct: num(state.ct),
        colormode: str(state.colormode),
        effect: str(state.effect),
        product,
      }),
    );
  }
  return lights.sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
}

/** v1 `/groups` → rooms and zones (other group types are internal to the bridge). */
export function parseGroups(data: unknown): HueGroup[] {
  if (!isObject(data)) return [];
  const groups: HueGroup[] = [];
  for (const [id, raw] of Object.entries(data)) {
    if (!isObject(raw) || (raw.type !== 'Room' && raw.type !== 'Zone')) continue;
    groups.push(
      compact<HueGroup>({
        id,
        name: str(raw.name) || `Group ${id}`,
        type: raw.type,
        class: str(raw.class),
        lightIds: Array.isArray(raw.lights) ? raw.lights.filter((x): x is string => typeof x === 'string') : [],
      }),
    );
  }
  return groups;
}

/** v1 `/scenes` → scenes. */
export function parseScenes(data: unknown): HueScene[] {
  if (!isObject(data)) return [];
  const scenes: HueScene[] = [];
  for (const [id, raw] of Object.entries(data)) {
    if (!isObject(raw)) continue;
    scenes.push(compact<HueScene>({ id, name: str(raw.name) || `Scene ${id}`, groupId: str(raw.group) }));
  }
  return scenes;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** v1 `/config` → bridge id and LAN address. The address is only served to an authorised key. */
export function parseBridgeInfo(data: unknown): BridgeInfo {
  const c = isObject(data) ? data : {};
  const id = str(c.bridgeid);
  const ip = str(c.ipaddress);
  return { id: id ? id.toLowerCase() : null, ip: ip && IPV4.test(ip) ? ip : null };
}

/**
 * Attaches each light's CLIP v2 resource (matched on `id_v1`). The v2 resource
 * is the source of truth for everything v1 cannot express: native effects,
 * gradients, dynamics.
 */
export function mergeV2(lights: readonly HueLight[], v2: readonly unknown[]): HueLight[] {
  const byV1 = new Map<string, Json>();
  for (const item of v2) {
    if (!isObject(item)) continue;
    const v1 = str(item.id_v1);
    if (v1?.startsWith('/lights/')) byV1.set(v1.slice('/lights/'.length), item);
  }
  return lights.map((light) => {
    const raw = byV1.get(light.id);
    const v2Id = raw && str(raw.id);
    return raw && v2Id ? { ...light, v2Id, v2: raw } : light;
  });
}

/** A CLIP v1 refusal, as {@link firstError} reads it. */
export interface V1Error {
  /** v1 error type (1 = unauthorized user, 7 = invalid value, 101 = link button not pressed…), when sent. */
  type: number | undefined;
  /** The bridge's own description, or a generic one. */
  description: string;
}

/**
 * The failure carried by a v1 answer, or `null`. v1 answers HTTP 200 even when
 * it refuses, so the body is what counts.
 *
 * A command counts as failed only when NOTHING applied: v1 handles each
 * attribute separately, and `{on, bri, hue}` sent to a white-only light applies
 * `on` and `bri` and refuses `hue`. That is not a failed command.
 */
export function firstError(data: unknown): V1Error | null {
  if (!Array.isArray(data)) return null;
  let found: V1Error | null = null;
  for (const item of data) {
    if (!isObject(item)) continue;
    if ('success' in item) return null;
    if (!found && isObject(item.error)) {
      found = {
        type: num(item.error.type),
        description: str(item.error.description) || 'The bridge refused the command.',
      };
    }
  }
  return found;
}

/** First `description` of a v2 error body (`{ errors: [{ description }] }`) or v1 error array. */
export function describeErrors(data: unknown): string {
  const v1 = firstError(data);
  if (v1) return v1.description;
  if (isObject(data) && Array.isArray(data.errors)) {
    for (const e of data.errors) {
      const d = isObject(e) ? str(e.description) : undefined;
      if (d) return d;
    }
  }
  return '';
}
