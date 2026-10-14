import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CloudTokens,
  createCloudTransport,
  createRelayClient,
  memoryTokenStore,
  type TokenStore,
} from '../src/index.js';
import { createRelayHandler } from '../src/relay.js';
import { fakeBridge, fakeRemote } from './fake-bridge.js';

function setup(o: { authorize?: (r: Request) => boolean; clientSecret?: string } = {}) {
  const bridge = fakeBridge();
  const remote = fakeRemote(bridge);
  const handler = createRelayHandler({
    clientId: 'client',
    clientSecret: o.clientSecret ?? 'secret',
    authorize: o.authorize ?? ((r) => r.headers.get('authorization') === 'Bearer session'),
    fetch: remote.fetch,
  });
  const relayCalls: Record<string, unknown>[] = [];
  const relay = createRelayClient({
    url: 'https://relay.example/hue',
    headers: { authorization: 'Bearer session' },
    fetch: async (input, init) => {
      relayCalls.push(JSON.parse(String(init?.body)));
      return handler(new Request(String(input), init));
    },
  });
  return { bridge, remote, handler, relay, relayCalls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const hour = (): number => Date.now() + 3600_000;
const someTokens = (): CloudTokens => ({ accessToken: 'a', refreshToken: 'r', expiresAt: hour(), appKey: 'k' });

async function connect(relay: ReturnType<typeof setup>['relay']): Promise<TokenStore & { writes: CloudTokens[] }> {
  const tokens = await relay.exchange('good-code');
  const store = memoryTokenStore(tokens);
  const writes: CloudTokens[] = [];
  return {
    writes,
    get: store.get,
    set: (t) => {
      writes.push(t);
      return store.set(t);
    },
  };
}

describe('relay', () => {
  it('builds the authorize URL without exposing the secret', async () => {
    const { relay } = setup();
    const url = new URL(await relay.authorizeUrl('xyz'));
    expect(url.origin + url.pathname).toBe('https://api.meethue.com/v2/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'client', response_type: 'code', state: 'xyz' });
  });

  it('exchanges a code and creates an app key through the remote link button', async () => {
    const { relay, bridge } = setup();
    const tokens = await relay.exchange('good-code');
    expect(tokens).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2', appKey: 'new-key-1' });
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
    expect(bridge.keys.has('new-key-1')).toBe(true);
  });

  it('refuses callers its authorize hook rejects', async () => {
    const { handler } = setup({ authorize: () => false });
    const response = await handler(
      new Request('https://r', { method: 'POST', body: JSON.stringify({ action: 'auth-url', state: 's' }) }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { reason: 'forbidden', message: 'Not allowed to use this relay.' },
    });
  });

  it('tells its own refusal (forbidden) from a refused Hue session (unauthorized)', async () => {
    const { relay } = setup({ authorize: () => false });
    await expect(relay.authorizeUrl('s')).rejects.toMatchObject({ name: 'HueError', reason: 'forbidden', status: 403 });
    const t = createCloudTransport({ relay, tokens: memoryTokenStore(someTokens()) });
    await expect(t.getLights()).rejects.toMatchObject({ reason: 'forbidden', status: 403 });
  });

  it('gives token calls longer than the client waits, and proxied calls less', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { relay } = setup();
    const tokens = await relay.exchange('good-code');
    // The token call, then the two calls that create the application key.
    expect(timeout.mock.calls).toEqual([[125_000], [15_000], [15_000]]);
    timeout.mockClear();
    await relay.proxy({ ...tokens, method: 'GET', path: `/api/${tokens.appKey}/lights` });
    expect(timeout.mock.calls).toEqual([[15_000]]);
  });

  it('only relays bridge routes', async () => {
    const { handler } = setup({ authorize: () => true });
    for (const path of ['/v2/oauth2/token', '/api/../v2/oauth2/token', '//evil.example/api/x', '/clip/v1/x']) {
      const response = await handler(
        new Request('https://r', {
          method: 'POST',
          body: JSON.stringify({ action: 'proxy', accessToken: 'a', method: 'GET', path }),
        }),
      );
      expect(response.status, path).toBe(400);
    }
  });

  it('reports an outage while creating the application key as one, not as a refusal', async () => {
    for (const [failStatus, failNext, reason] of [
      [503, 2, 'unavailable'], // the press and the key request
      [503, 1, 'unavailable'], // the press only: the key request then says "link button not pressed"
      [429, 2, 'rate-limited'],
    ] as const) {
      const { relay, remote } = setup();
      Object.assign(remote, { failStatus, failNext });
      await expect(relay.exchange('good-code'), `${failStatus} x${failNext}`).rejects.toMatchObject({
        name: 'HueError',
        reason,
        status: 502,
      });
    }
  });

  it("blames its own client credentials, not the user's Hue session, when Philips refuses them", async () => {
    const { relay, remote } = setup({ clientSecret: 'wrong' });
    const misconfigured = {
      reason: 'unavailable',
      status: 502,
      message: expect.stringContaining('client credentials'),
    };
    await expect(relay.exchange('good-code')).rejects.toMatchObject(misconfigured);
    await expect(relay.refresh(remote.refreshToken)).rejects.toMatchObject(misconfigured);
    // A refresh token Philips refuses still means reconnecting Hue.
    await expect(setup().relay.refresh('spent')).rejects.toMatchObject({ reason: 'unauthorized', status: 401 });
  });

  it('refuses to start without credentials or with a device type the bridge would refuse', () => {
    const authorize = (): boolean => true;
    const unset = undefined as unknown as string; // what `process.env.HUE_CLIENT_SECRET!` passes when it is not set
    expect(() => createRelayHandler({ clientId: '', clientSecret: 'secret', authorize })).toThrow(TypeError);
    expect(() => createRelayHandler({ clientId: 'client', clientSecret: unset, authorize })).toThrow(TypeError);
    for (const deviceType of ['no-hash', `${'a'.repeat(21)}#dev`, `app#${'d'.repeat(20)}`, 'a#b#c', '#dev', 'app#']) {
      expect(() => createRelayHandler({ clientId: 'c', clientSecret: 's', authorize, deviceType }), deviceType).toThrow(
        TypeError,
      );
    }
    expect(createRelayHandler({ clientId: 'c', clientSecret: 's', authorize, deviceType: 'app#relay' })).toBeTypeOf(
      'function',
    );
  });

  it('answers CORS preflights with the headers the client asked for', async () => {
    const { handler } = setup();
    const response = await handler(
      new Request('https://r', {
        method: 'OPTIONS',
        headers: { 'access-control-request-headers': 'authorization, apikey, content-type' },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toBe('authorization, apikey, content-type');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('relay client', () => {
  const page = (): Response =>
    new Response('<!doctype html><title>Sign in</title>', { status: 200, headers: { 'content-type': 'text/html' } });

  it('refuses a 200 that is not the relay talking (a sign-in page, a wrong URL)', async () => {
    for (const answer of [page, () => Response.json({}), () => Response.json({ url: 42, status: '200' })]) {
      const relay = createRelayClient({ url: 'https://relay.example/hue', fetch: async () => answer() });
      const unexpected = { name: 'HueError', reason: 'unavailable', message: expect.stringContaining('check its URL') };
      await expect(relay.authorizeUrl('s')).rejects.toMatchObject(unexpected);
      await expect(relay.exchange('code')).rejects.toMatchObject(unexpected);
      await expect(relay.refresh('rt')).rejects.toMatchObject(unexpected);
      const t = createCloudTransport({ relay, tokens: memoryTokenStore(someTokens()) });
      await expect(t.getLights()).rejects.toMatchObject(unexpected);
    }
  });

  it('reads a 401 or 403 the relay did not write as its gate refusing, not Hue', async () => {
    // What a Supabase gateway answers for an expired session, before the relay runs.
    const gateway = createRelayClient({
      url: 'https://relay.example/hue',
      fetch: async () => Response.json({ code: 401, message: 'Invalid JWT' }, { status: 401 }),
    });
    await expect(gateway.authorizeUrl('s')).rejects.toMatchObject({ reason: 'forbidden', status: 401 });
  });

  it('resends a call the gateway dropped only when sending it twice is harmless', async () => {
    const gatewayOnce = () => {
      let calls = 0;
      const relay = createRelayClient({
        url: 'https://relay.example/hue',
        fetch: async () =>
          ++calls === 1
            ? new Response('Gateway Timeout', { status: 504, headers: { 'content-type': 'text/plain' } })
            : Response.json({ status: 200, data: [] }),
      });
      return { relay, calls: () => calls };
    };
    const call = { accessToken: 'a', appKey: 'k', path: '/api/k/schedules' };
    for (const method of ['GET', 'PUT'] as const) {
      const g = gatewayOnce();
      await expect(g.relay.proxy({ ...call, method })).resolves.toEqual({ status: 200, data: [] });
      expect(g.calls(), method).toBe(2);
    }
    for (const method of ['POST', 'DELETE'] as const) {
      const g = gatewayOnce();
      await expect(g.relay.proxy({ ...call, method })).rejects.toMatchObject({ reason: 'unavailable', status: 504 });
      expect(g.calls(), method).toBe(1);
    }
  });

  it('keeps only the reasons it knows from a relay error', async () => {
    const relay = createRelayClient({
      url: 'https://relay.example/hue',
      fetch: async () => Response.json({ error: { reason: 'teapot', message: 'Nope.' } }, { status: 400 }),
    });
    await expect(relay.authorizeUrl('s')).rejects.toMatchObject({ reason: 'rejected', message: 'Nope.', status: 400 });
  });
});

describe('cloud transport', () => {
  it('reads v1 and v2 through the relay', async () => {
    const { relay } = setup();
    const t = createCloudTransport({ relay, tokens: await connect(relay) });
    expect((await t.getLights()).length).toBe(3);
    expect((await t.getV2Lights()).length).toBe(3);
    await t.writeV2('v2-1', { effects: { effect: 'fire' } });
    expect(await t.appKey()).toBe('new-key-1');
  });

  it('refreshes on a 401, once, and stores the rotated tokens', async () => {
    const { relay, remote } = setup();
    const tokens = await connect(relay);
    const t = createCloudTransport({ relay, tokens });
    remote.expireAccessToken();
    await Promise.all([t.getLights(), t.getGroups(), t.getScenes()]);
    expect(remote.tokenCalls).toBe(2); // exchange + ONE refresh
    expect(tokens.writes.map((w) => w.refreshToken)).toEqual(['rt-3']);
  });

  it('adopts tokens another tab already rotated instead of spending a refresh', async () => {
    const { relay, remote } = setup();
    const tokens = await connect(relay);
    const tab1 = createCloudTransport({ relay, tokens });
    const tab2 = createCloudTransport({ relay, tokens });
    await tab1.getLights(); // tab1 now holds the current tokens
    remote.expireAccessToken();
    await tab2.getLights(); // tab2 refreshes: rt-2 is spent, rt-3 stored
    expect(remote.tokenCalls).toBe(2);
    await tab1.getLights(); // tab1 gets a 401 with its old token: it must adopt rt-3, not spend rt-2
    expect(remote.tokenCalls).toBe(2);
  });

  it('keeps rotated tokens in memory when the store fails to save them', async () => {
    const { relay, remote } = setup();
    const saved = memoryTokenStore(await relay.exchange('good-code'));
    let failures = 1;
    const tokens: TokenStore = {
      get: saved.get,
      set: (next) => {
        if (failures-- > 0) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        saved.set(next);
      },
    };
    const t = createCloudTransport({ relay, tokens });
    remote.expireAccessToken();
    await expect(t.getLights()).resolves.toHaveLength(3);
    await expect(t.getLights()).resolves.toHaveLength(3);
    expect(remote.tokenCalls).toBe(2); // exchange + ONE refresh: the rotated refresh token was not lost
  });

  it('reports a token store that cannot be read as a HueError', async () => {
    const { relay, remote } = setup();
    const cause = new Error('storage disabled');
    const broken = createCloudTransport({ relay, tokens: { get: () => Promise.reject(cause), set: () => {} } });
    await expect(broken.getLights()).rejects.toMatchObject({ name: 'HueError', reason: 'unavailable', cause });
    await expect(broken.appKey()).rejects.toMatchObject({ name: 'HueError', reason: 'unavailable', cause });

    // Readable at first, then not, when a refresh re-reads it.
    const saved = memoryTokenStore(await relay.exchange('good-code'));
    let reads = 0;
    const flaky: TokenStore = {
      get: () => {
        if (reads++ > 0) throw cause;
        return saved.get();
      },
      set: saved.set,
    };
    const t = createCloudTransport({ relay, tokens: flaky });
    await t.getLights();
    remote.expireAccessToken();
    await expect(t.getLights()).rejects.toMatchObject({ name: 'HueError', reason: 'unavailable', cause });
  });

  it('retries a rate limit with backoff, then succeeds', async () => {
    const { relay, remote } = setup();
    const t = createCloudTransport({ relay, tokens: await connect(relay) });
    remote.failNext = 1;
    await expect(t.setLight('1', { on: true })).resolves.toBeUndefined();
  });

  it('resends a POST after a rate limit, never after a gateway error that may have applied it', async () => {
    const { relay, remote, relayCalls } = setup();
    const t = createCloudTransport({ relay, tokens: await connect(relay) });
    const posts = (): number => relayCalls.filter((c) => c.action === 'proxy' && c.method === 'POST').length;
    const schedule = { method: 'POST', path: '/schedules', body: { name: 'wake' } } as const;

    Object.assign(remote, { failStatus: 504, failNext: 1 });
    await expect(t.request(schedule)).rejects.toMatchObject({ reason: 'unavailable', status: 504 });
    expect(posts()).toBe(1);

    Object.assign(remote, { failStatus: 429, failNext: 1 });
    await t.request(schedule).catch(() => {}); // the fake bridge has no schedules: only the resend matters
    expect(posts()).toBe(3);

    Object.assign(remote, { failStatus: 503, failNext: 1 });
    await expect(t.getLights()).resolves.toHaveLength(3);
  });

  it('does not retry once the owning effect is stopped', async () => {
    const { relay, remote, bridge } = setup();
    const t = createCloudTransport({ relay, tokens: await connect(relay) });
    remote.failNext = 5;
    const controller = new AbortController();
    const pending = t.setLight('1', { on: true }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({
      reason: 'aborted',
      message: 'Command not sent: the effect was stopped.',
    });
    expect(bridge.writes().filter((w) => w.path.includes('/lights/1/state'))).toEqual([]);
    expect(remote.failNext).toBe(4);
  });

  it('reads v1 refusals hidden in a 200', async () => {
    const { relay } = setup();
    const t = createCloudTransport({ relay, tokens: await connect(relay) });
    await expect(t.setLight('99', { on: true })).rejects.toMatchObject({ reason: 'rejected', code: 3 });
  });

  it('reports a session the remote API refuses for good', async () => {
    const { relay, remote } = setup();
    const t = createCloudTransport({ relay, tokens: await connect(relay) });
    remote.expireAccessToken();
    remote.refreshToken = 'revoked';
    await expect(t.getLights()).rejects.toMatchObject({ reason: 'unauthorized' });
  });

  it('presses the link button remotely', async () => {
    const { relay, bridge } = setup();
    const t = createCloudTransport({ relay, tokens: await connect(relay) });
    await t.pressLinkButton();
    const press = bridge.log.filter((l) => l.path === '/api/0/config' && l.method === 'PUT');
    expect(press.length).toBe(2); // once at exchange, once now
  });

  it('is not connected without tokens', async () => {
    const { relay } = setup();
    const t = createCloudTransport({ relay, tokens: memoryTokenStore() });
    await expect(t.getLights()).rejects.toMatchObject({ reason: 'unauthorized' });
    expect(await t.appKey()).toBeNull();
  });

  it('reports credentials that cannot be produced as forbidden', async () => {
    const { handler } = setup();
    const relay = createRelayClient({
      url: 'https://relay.example/hue',
      headers: () => {
        throw new Error('signed out');
      },
      fetch: (input, init) => handler(new Request(String(input), init)),
    });
    await expect(relay.authorizeUrl('s')).rejects.toMatchObject({ name: 'HueError', reason: 'forbidden' });
  });

  it('shares rotated tokens between transports of a page when the store cannot save them', async () => {
    const { relay, remote } = setup();
    const initial = await relay.exchange('good-code');
    const tokens: TokenStore = {
      get: () => initial,
      set: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const first = createCloudTransport({ relay, tokens });
    const second = createCloudTransport({ relay, tokens });
    await second.getLights(); // holds the initial tokens
    remote.expireAccessToken();
    await first.getLights(); // rotates; the store keeps the spent ones
    expect(remote.tokenCalls).toBe(2);
    await second.getLights(); // 401: must adopt the rotated tokens, not spend the dead refresh token
    await createCloudTransport({ relay, tokens }).getLights(); // a transport created later, too
    expect(remote.tokenCalls).toBe(2);
  });

  it('takes a store that holds nothing at its word, over the tokens this page rotated', async () => {
    const { relay, remote } = setup();
    let saved: CloudTokens | null = await relay.exchange('good-code');
    const tokens: TokenStore = {
      get: () => saved,
      set: (next) => {
        saved = next;
      },
    };
    const t = createCloudTransport({ relay, tokens });
    remote.expireAccessToken();
    await t.getLights(); // rotated in this page
    saved = null; // disconnected (or about to connect another account)
    await expect(createCloudTransport({ relay, tokens }).getLights()).rejects.toMatchObject({ reason: 'unauthorized' });
    remote.expireAccessToken();
    await expect(t.getLights()).rejects.toMatchObject({ reason: 'unauthorized' });
    expect(saved).toBeNull(); // not written back
    expect(remote.tokenCalls).toBe(2); // exchange + the first refresh only
    await expect(t.getLights()).rejects.toMatchObject({ reason: 'unauthorized' });
  });

  it('lets a store emptied or reconnected while a refresh is in flight win over the tokens it brings', async () => {
    for (const other of [null, { accessToken: 'b-at', refreshToken: 'b-rt', expiresAt: hour(), appKey: 'b-key' }]) {
      const { relay, remote } = setup();
      let saved: CloudTokens | null = await relay.exchange('good-code');
      let release = (): void => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = (): void => {};
      const refreshing = new Promise<void>((resolve) => {
        started = resolve;
      });
      const t = createCloudTransport({
        relay: {
          ...relay,
          refresh: (rt) => {
            started();
            return released.then(() => relay.refresh(rt));
          },
        },
        tokens: {
          get: () => saved,
          set: (next) => {
            saved = next;
          },
        },
      });
      remote.expireAccessToken();
      const lights = t.getLights().catch((e: unknown) => e);
      await refreshing;
      saved = other; // disconnected, or another account connected, meanwhile
      release();
      await lights;
      expect(saved).toEqual(other); // the old connection is not written back
      expect(await t.appKey()).toBe(other?.appKey ?? null);
    }
  });

  it('adopts the tokens another tab rotated from the very refresh token it was refused', async () => {
    const { relay, remote } = setup();
    let shared = await relay.exchange('good-code'); // like localStorage: one per origin, a store object per tab
    const gate = () => {
      let open = (): void => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { opened, open };
    };
    const tab2Refreshing = gate();
    const tab1Saved = gate();
    const tab = (onSet: () => void, beforeRefresh: () => Promise<void>) =>
      createCloudTransport({
        relay: { ...relay, refresh: (rt) => beforeRefresh().then(() => relay.refresh(rt)) },
        tokens: {
          get: () => shared,
          set: (next) => {
            shared = next;
            onSet();
          },
        },
      });
    // Both read the same refresh token; tab 1 spends it and saves, then tab 2 presents it.
    const tab1 = tab(tab1Saved.open, () => tab2Refreshing.opened);
    const tab2 = tab(
      () => {},
      () => {
        tab2Refreshing.open();
        return tab1Saved.opened;
      },
    );
    remote.expireAccessToken();
    await expect(Promise.all([tab1.getLights(), tab2.getLights()])).resolves.toHaveLength(2);
    expect(remote.tokenCalls).toBe(3); // exchange, tab 1's refresh, tab 2's refused one
    expect(shared.refreshToken).toBe('rt-3');
  });
});
