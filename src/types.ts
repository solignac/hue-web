/** A light, normalised from its CLIP v1 resource and, when served, its CLIP v2 one. */
export interface HueLight {
  /** CLIP v1 id (`"1"`, `"2"`…), the one every command takes. */
  readonly id: string;
  readonly name: string;
  readonly on: boolean;
  /** `false` when the light has no power (wall switch off). v1 keeps `on: true` for those. */
  readonly reachable: boolean;
  /** Brightness, 1–254. */
  readonly bri?: number;
  /** Hue, 0–65535. */
  readonly hue?: number;
  /** Saturation, 0–254. */
  readonly sat?: number;
  /** Colour temperature in mirek (153 cold … 500 warm). */
  readonly ct?: number;
  /** `hs`, `xy` or `ct`: which of the above the light is rendering. */
  readonly colormode?: string;
  /** CLIP v1 effect: `none` or `colorloop`. */
  readonly effect?: string;
  readonly product: LightProduct;
  /** CLIP v2 id, when the transport serves v2. */
  readonly v2Id?: string;
  /** Raw CLIP v2 resource: the full state space (native effects, gradient, dynamics…). */
  readonly v2?: Readonly<Record<string, unknown>>;
}

/** What a light is, as it declares itself. Every field is optional: bridges and lights omit some. */
export interface LightProduct {
  /** v1 `type`, e.g. `Extended color light`. */
  readonly type?: string;
  /** v1 `modelid`, e.g. `LCT015`. */
  readonly modelId?: string;
  /** v1 `productname`, e.g. `Hue color lamp`. */
  readonly name?: string;
  /** v1 `manufacturername`. */
  readonly manufacturer?: string;
  /** v1 `config.archetype`, e.g. `sultanbulb` or `plug`. */
  readonly archetype?: string;
  /** Colour gamut: `A`, `B` or `C`. */
  readonly gamut?: string;
  /** Supported colour temperatures in mirek, `[coldest, warmest]`. */
  readonly ctRange?: readonly [number, number];
  /** v1 `mindimlevel` (thousandths of a percent). */
  readonly minDimLevel?: number;
}

/** A room or a zone. */
export interface HueGroup {
  /** v1 group id, the one `setGroup` takes. */
  readonly id: string;
  readonly name: string;
  readonly type: 'Room' | 'Zone';
  /** Room class, e.g. `Living room` or `Bedroom`. */
  readonly class?: string;
  /** v1 ids of its lights. */
  readonly lightIds: readonly string[];
}

/** A saved scene. */
export interface HueScene {
  /** v1 scene id, the one `recallScene` takes. */
  readonly id: string;
  readonly name: string;
  /** Group the scene belongs to (v1 `GroupScene`), if any. */
  readonly groupId?: string;
}

/** A CLIP v1 state change. Only the fields you set are sent. */
export interface LightState {
  on?: boolean | undefined;
  /** 1–254 */
  bri?: number | undefined;
  /** 0–65535 */
  hue?: number | undefined;
  /** 0–254 */
  sat?: number | undefined;
  /** CIE 1931 coordinates; the bridge clamps them to the light's gamut. */
  xy?: readonly [number, number] | undefined;
  /** Mirek, 153–500. */
  ct?: number | undefined;
  effect?: 'none' | 'colorloop' | undefined;
  /** Fade duration, in tenths of a second. The bridge interpolates on its own. */
  transitiontime?: number | undefined;
}

/** Options of a command. */
export interface SendOptions {
  /**
   * Once aborted, nothing more is sent and nothing is retried. A request already
   * on the wire is NOT cancelled: the bridge would apply it anyway, and its
   * acknowledgement is what an effect's stop barrier waits for.
   */
  signal?: AbortSignal | undefined;
}

/** Which bridge a transport reaches, and where it is. */
export interface BridgeInfo {
  /** Bridge id, lower case. */
  readonly id: string | null;
  /** Address on the local network, as the bridge sees itself. */
  readonly ip: string | null;
}

/** A raw request. v1 paths are relative to `/api/<appKey>`, v2 paths to `/clip/v2`. */
export interface HueRequest {
  /** HTTP method. */
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  /** Path under `/api/<appKey>` (v1) or `/clip/v2` (v2), e.g. `/sensors`. */
  path: string;
  /** JSON body, ignored for `GET`. */
  body?: unknown;
  /** A CLIP v2 call. */
  v2?: boolean | undefined;
  /** As in {@link SendOptions}: once aborted, nothing more is sent or retried. */
  signal?: AbortSignal | undefined;
}

/**
 * How commands reach a bridge. Local (browser → bridge) and cloud (browser →
 * relay → Philips remote API → bridge) implement the same interface, so
 * everything above them is transport-agnostic.
 */
export interface HueTransport {
  /** `local` (browser → bridge) or `cloud` (browser → relay → remote API → bridge). */
  readonly kind: 'local' | 'cloud';
  /** Where commands go, for display: the bridge host, or `cloud`. */
  readonly label: string;
  /** Every light, from CLIP v1. */
  getLights(): Promise<HueLight[]>;
  /** Raw CLIP v2 light resources; `[]` when the transport cannot serve v2. */
  getV2Lights(): Promise<unknown[]>;
  /** Rooms and zones. */
  getGroups(): Promise<HueGroup[]>;
  /** Saved scenes. */
  getScenes(): Promise<HueScene[]>;
  /** Which bridge this is, and its LAN address. */
  getBridgeInfo(): Promise<BridgeInfo>;
  /** Changes one light. Resolves once the bridge applied it, even partly (see `firstError`). */
  setLight(id: string, state: LightState, options?: SendOptions): Promise<void>;
  /** Changes every light of a group at once; group `0` is every light. */
  setGroup(id: string, state: LightState, options?: SendOptions): Promise<void>;
  /** Recalls a scene on a group. */
  recallScene(groupId: string, sceneId: string, options?: SendOptions): Promise<void>;
  /** PUT a CLIP v2 light resource (native effects, gradients…). */
  writeV2(v2Id: string, body: Record<string, unknown>, options?: SendOptions): Promise<void>;
  /** Escape hatch for anything else the API offers (sensors, schedules…). */
  request(request: HueRequest): Promise<unknown>;
}
