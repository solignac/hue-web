/**
 * An in-memory Hue bridge behind a `fetch`, plus the Philips remote API in front
 * of it. Enough of the real behaviour to test against: v1 answers 200 with
 * error arrays, per-attribute success, keys and the link button, CLIP v2,
 * OAuth token rotation, and a browser's CORS refusal of v2 headers.
 */

type State = Record<string, unknown>;

export interface FakeLightInit {
  name?: string;
  color?: boolean;
  plug?: boolean;
  effects?: string[];
  state?: State;
}

interface FakeLight {
  name: string;
  color: boolean;
  plug: boolean;
  effects: string[];
  effect: string;
  state: State;
}

export interface Logged {
  host: string;
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

export interface FakeBridgeOptions {
  id?: string;
  ip?: string;
  /** Hosts that answer (default: the ip and philips-hue.local). */
  hosts?: string[];
  lights?: Record<string, FakeLightInit>;
  groups?: Record<string, { name: string; type: 'Room' | 'Zone'; lights: string[] }>;
  keys?: string[];
  /** Per-request latency, ms. */
  latencyMs?: number;
  /** Behave like a browser: requests carrying `hue-application-key` fail CORS. */
  browser?: boolean;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function fakeBridge(options: FakeBridgeOptions = {}) {
  const id = options.id ?? 'ECB5FAFFFE0A1B2C';
  const ip = options.ip ?? '192.168.1.20';
  const hosts = new Set(options.hosts ?? [ip, 'philips-hue.local']);
  const keys = new Set(options.keys ?? ['local-key']);
  const lights = new Map<string, FakeLight>();
  for (const [lid, init] of Object.entries(
    options.lights ?? {
      '1': { name: 'Lamp', color: true, effects: ['candle', 'fire'] },
      '2': { name: 'Bulb', color: true },
      '3': { name: 'White', color: false },
    },
  )) {
    const base: State = init.plug
      ? { on: false, reachable: true }
      : { on: false, bri: 100, ct: 300, colormode: 'ct', reachable: true };
    if (init.color && !init.plug) Object.assign(base, { hue: 0, sat: 0, xy: [0.3, 0.3], effect: 'none' });
    lights.set(lid, {
      name: init.name ?? `L${lid}`,
      color: !!init.color,
      plug: !!init.plug,
      effects: init.effects ?? [],
      effect: 'no_effect',
      state: { ...base, ...init.state },
    });
  }
  const groups = options.groups ?? { '1': { name: 'Living room', type: 'Room' as const, lights: [...lights.keys()] } };
  const log: Logged[] = [];
  let buttonUntil = 0;
  let inFlight = 0;
  let nextKey = 1;
  const bridge = {
    id,
    ip,
    hosts,
    keys,
    lights,
    log,
    latencyMs: options.latencyMs ?? 0,
    browser: options.browser ?? false,
    maxInFlight: 0,
    /** Requests received and not answered yet. */
    pending: (): number => inFlight,
    /** Fail the next N state writes with this v1 error type. */
    failWrites: 0,
    failType: 7,
    pressButton(): void {
      buttonUntil = Date.now() + 30_000;
    },
    writes(): Logged[] {
      return log.filter((l) => l.method !== 'GET');
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      if (!hosts.has(url.hostname)) throw new TypeError('fetch failed');
      if (bridge.browser && headers.has('hue-application-key')) throw new TypeError('Failed to fetch');
      return handle(url.hostname, init?.method ?? 'GET', url.pathname, init?.body, headers, init?.signal ?? undefined);
    }) as typeof fetch,
    /** Entry point for the remote API (no host check, no CORS). */
    handle: (method: string, path: string, body: BodyInit | null | undefined, headers: Headers) =>
      handle('remote', method, path, body, headers, undefined),
  };

  function v1Light(lid: string, l: FakeLight): State {
    return {
      name: l.name,
      type: l.plug ? 'On/Off plug-in unit' : l.color ? 'Extended color light' : 'Color temperature light',
      productname: l.plug ? 'Hue smart plug' : 'Hue color lamp',
      modelid: 'LCT015',
      uniqueid: `00:17:88:01:00:00:00:0${lid}-0b`,
      state: l.state,
      capabilities: {
        control: l.plug
          ? {}
          : { mindimlevel: 200, ct: { min: 153, max: 454 }, ...(l.color && { colorgamuttype: 'C' }) },
      },
      config: { archetype: l.plug ? 'plug' : 'sultanbulb' },
    };
  }

  function v2Light(lid: string, l: FakeLight): State {
    return {
      id: `v2-${lid}`,
      id_v1: `/lights/${lid}`,
      type: 'light',
      on: { on: l.state.on },
      ...(!l.plug && { dimming: { brightness: 50, min_dim_level: 0.2 } }),
      ...(!l.plug && { color_temperature: { mirek: 300, mirek_schema: { mirek_minimum: 153, mirek_maximum: 454 } } }),
      ...(l.color && { color: { xy: { x: 0.3, y: 0.3 } } }),
      ...(l.effects.length && {
        effects: {
          status: l.effect,
          effect_values: ['no_effect', ...l.effects],
          status_values: ['no_effect', ...l.effects],
        },
        effects_v2: { action: { effect_values: ['no_effect', ...l.effects] }, status: { effect: l.effect } },
      }),
    };
  }

  function apply(l: FakeLight, patch: State, prefix: string): State[] {
    const out: State[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'transitiontime') continue;
      const colorKey = k === 'hue' || k === 'sat' || k === 'xy' || k === 'effect';
      if ((colorKey && !l.color) || (l.plug && k !== 'on')) {
        out.push({ error: { type: 6, address: `${prefix}/${k}`, description: `parameter, ${k}, not available` } });
        continue;
      }
      l.state[k] = v;
      if (k === 'xy' || k === 'hue' || k === 'sat') l.state.colormode = k === 'xy' ? 'xy' : 'hs';
      if (k === 'ct') l.state.colormode = 'ct';
      out.push({ success: { [`${prefix}/${k}`]: v } });
    }
    return out;
  }

  async function handle(
    host: string,
    method: string,
    path: string,
    rawBody: BodyInit | null | undefined,
    headers: Headers,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const body = typeof rawBody === 'string' && rawBody ? JSON.parse(rawBody) : undefined;
    log.push({ host, method, path, body, headers });
    inFlight += 1;
    bridge.maxInFlight = Math.max(bridge.maxInFlight, inFlight);
    try {
      if (bridge.latencyMs) await sleep(bridge.latencyMs);
      void signal; // like a real bridge: a request on the wire is applied anyway
      return route(method, path, body, headers);
    } finally {
      inFlight -= 1;
    }
  }

  function route(method: string, path: string, body: State | undefined, headers: Headers): Response {
    if (path === '/api/0/config' && method === 'GET')
      return json({ name: 'Hue Bridge', bridgeid: id, apiversion: '1.70.0' });
    if (path === '/api/0/config' && method === 'PUT') {
      // Only honoured through the remote API (which authenticates by OAuth).
      if (body?.linkbutton === true) bridge.pressButton();
      return json([{ success: { '/config/linkbutton': true } }]);
    }
    if (path === '/api' && method === 'POST') {
      if (Date.now() > buttonUntil)
        return json([{ error: { type: 101, address: '', description: 'link button not pressed' } }]);
      const key = `new-key-${nextKey++}`;
      keys.add(key);
      return json([{ success: { username: key } }]);
    }
    if (path.startsWith('/clip/v2/')) {
      const key = headers.get('hue-application-key');
      if (!key || !keys.has(key)) return json({ errors: [{ description: 'unauthorized user' }], data: [] }, 403);
      if (path === '/clip/v2/resource/light' && method === 'GET') {
        return json({ errors: [], data: [...lights].map(([lid, l]) => v2Light(lid, l)) });
      }
      const m = /^\/clip\/v2\/resource\/light\/v2-(\w+)$/.exec(path);
      const l = m?.[1] ? lights.get(m[1]) : undefined;
      if (!l) return json({ errors: [{ description: 'not found' }], data: [] }, 404);
      const fx =
        (body?.effects as State | undefined)?.effect ??
        ((body?.effects_v2 as State | undefined)?.action as State | undefined)?.effect;
      if (typeof fx === 'string') l.effect = fx;
      return json({ errors: [], data: [{ rid: `v2-${m?.[1]}`, rtype: 'light' }] });
    }
    const m = /^\/api\/([^/]+)(\/.*)?$/.exec(path);
    if (!m?.[1]) return json({ error: 'not found' }, 404);
    if (!keys.has(decodeURIComponent(m[1])))
      return json([{ error: { type: 1, address: m[2] ?? '/', description: 'unauthorized user' } }]);
    const rest = m[2] ?? '';
    if (method === 'GET' && rest === '/lights')
      return json(Object.fromEntries([...lights].map(([lid, l]) => [lid, v1Light(lid, l)])));
    if (method === 'GET' && rest === '/groups') {
      return json(
        Object.fromEntries(Object.entries(groups).map(([gid, g]) => [gid, { ...g, class: 'Living room', action: {} }])),
      );
    }
    if (method === 'GET' && rest === '/scenes') return json({ abc: { name: 'Relax', group: '1', type: 'GroupScene' } });
    if (method === 'GET' && rest === '/config') return json({ name: 'Hue Bridge', bridgeid: id, ipaddress: ip });
    const ls = /^\/lights\/(\w+)\/state$/.exec(rest);
    if (method === 'PUT' && ls?.[1]) {
      const l = lights.get(ls[1]);
      if (!l) return json([{ error: { type: 3, address: rest, description: 'resource not available' } }]);
      if (bridge.failWrites > 0) {
        bridge.failWrites -= 1;
        return json([{ error: { type: bridge.failType, address: rest, description: 'invalid value' } }]);
      }
      return json(apply(l, body ?? {}, `/lights/${ls[1]}/state`));
    }
    const ga = /^\/groups\/(\w+)\/action$/.exec(rest);
    if (method === 'PUT' && ga?.[1]) {
      const ids = ga[1] === '0' ? [...lights.keys()] : (groups[ga[1]]?.lights ?? []);
      if (body?.scene) return json([{ success: { address: `/groups/${ga[1]}/action/scene`, value: body.scene } }]);
      const results = ids.flatMap((lid) => {
        const l = lights.get(lid);
        return l ? apply(l, body ?? {}, `/groups/${ga[1]}/action`) : [];
      });
      return json(results.some((r) => 'success' in r) ? results.filter((r) => 'success' in r) : results);
    }
    return json([{ error: { type: 4, address: rest, description: 'method not available' } }]);
  }

  return bridge;
}

export type FakeBridge = ReturnType<typeof fakeBridge>;

/**
 * The Philips remote API (api.meethue.com) in front of a fake bridge: OAuth
 * token endpoint with rotation, and `/route/…` authenticated by bearer.
 */
export function fakeRemote(bridge: FakeBridge, client = { id: 'client', secret: 'secret' }) {
  let generation = 1;
  const remote = {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    tokenCalls: 0,
    /** Answer the next N route calls with this HTTP status. */
    failNext: 0,
    failStatus: 429,
    /** Make the current access token invalid (as if expired). */
    expireAccessToken(): void {
      remote.accessToken = `expired-${remote.accessToken}`;
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      if (url.origin !== 'https://api.meethue.com') throw new TypeError('fetch failed');
      if (url.pathname === '/v2/oauth2/token') {
        remote.tokenCalls += 1;
        if (headers.get('authorization') !== `Basic ${btoa(`${client.id}:${client.secret}`)}`)
          return json({ error: 'invalid_client' }, 401);
        const form = new URLSearchParams(String(init?.body));
        const ok =
          (form.get('grant_type') === 'authorization_code' && form.get('code') === 'good-code') ||
          (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === remote.refreshToken);
        if (!ok) return json({ error: 'invalid_grant' }, 400);
        generation += 1;
        remote.accessToken = `at-${generation}`;
        remote.refreshToken = `rt-${generation}`;
        return json({
          access_token: remote.accessToken,
          refresh_token: remote.refreshToken,
          expires_in: 604800,
          token_type: 'bearer',
        });
      }
      if (!url.pathname.startsWith('/route/')) return json({ error: 'not found' }, 404);
      if (headers.get('authorization') !== `Bearer ${remote.accessToken}`) return json({ fault: 'invalid token' }, 401);
      if (remote.failNext > 0) {
        remote.failNext -= 1;
        return json({ fault: 'too many requests' }, remote.failStatus);
      }
      const path = url.pathname.slice('/route'.length);
      if ((path === '/api/0/config' || path === '/api') && headers.get('content-type') !== 'application/json') {
        return json({ fault: 'unsupported media type' }, 415);
      }
      return bridge.handle(init?.method ?? 'GET', path, init?.body, headers);
    }) as typeof fetch,
  };
  return remote;
}
