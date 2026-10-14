import { HueError, isHueError, isHueErrorReason, reasonForCode, reasonForStatus, throwIfAborted } from '../errors.js';
import { defaultFetch, fetchWithin, sleepUnless } from '../internal/async.js';
import { describeErrors, firstError } from '../parse.js';
import type { HueRequest, HueTransport } from '../types.js';
import { transportOver } from './base.js';

/** What a cloud connection needs. Keep it like a password: it controls the lights. */
export interface CloudTokens {
  /** OAuth access token, sent with every call. Lasts about a week. */
  accessToken: string;
  /** OAuth refresh token. Single-use: each refresh spends it and returns the next one. */
  refreshToken: string;
  /** When the access token expires, epoch ms. */
  expiresAt: number;
  /** Application key the relay created on the bridge (the remote API "username"). */
  appKey: string;
}

/**
 * Where cloud tokens live. Tokens rotate on every refresh, so the transport
 * writes them back; it also re-reads before refreshing, to adopt tokens another
 * tab or device already rotated (a rotated refresh token is single-use).
 */
export interface TokenStore {
  /**
   * The saved tokens, or `null` when not connected. `null` is final: the
   * transport then drops the tokens it holds at its next refresh, rather than
   * write them back. A failure surfaces as reason `unavailable`.
   */
  get(): CloudTokens | null | Promise<CloudTokens | null>;
  /**
   * Saves rotated tokens. It may fail (a full `localStorage`): the transport then
   * keeps going with the tokens in memory, but other tabs and later visits will
   * not see them.
   */
  set(tokens: CloudTokens): void | Promise<void>;
}

/** A {@link TokenStore} that lives as long as the page. */
export function memoryTokenStore(initial: CloudTokens | null = null): TokenStore {
  let tokens = initial;
  return {
    get: () => tokens,
    set: (next) => {
      tokens = next;
    },
  };
}

/** Options of {@link createRelayClient}. */
export interface RelayClientOptions {
  /** URL of your relay (see `hue-web/relay`). */
  url: string;
  /**
   * Headers your relay's `authorize` hook checks, e.g. a session bearer. A
   * function is called before each call, so a refreshed session is picked up.
   */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Custom `fetch`. Default: the global one, resolved at call time. */
  fetch?: typeof fetch;
  /**
   * Deadline for proxied calls. Default 20 s. Token calls always get 120 s:
   * giving up on them early could lose tokens Philips already rotated.
   */
  timeoutMs?: number;
}

/** One call to relay to the Philips remote API. */
export interface ProxyCall {
  /** OAuth access token of the connection. */
  accessToken: string;
  /** Application key on the bridge; CLIP v2 calls send it as `hue-application-key`. */
  appKey: string;
  /** HTTP method. */
  method: HueRequest['method'];
  /** Path under the remote API's `/route`, e.g. `/api/<appKey>/lights`. */
  path: string;
  /** JSON body, ignored for `GET`. */
  body?: unknown;
  /** A CLIP v2 call (`/clip/v2/…`). */
  v2?: boolean;
}

/** Talks to a relay created with `createRelayHandler` from `hue-web/relay`. */
export interface RelayClient {
  /** URL to send the user to, to grant your app access to their bridge. */
  authorizeUrl(state: string): Promise<string>;
  /** Trades the OAuth `code` for tokens, and creates the app key on the bridge. */
  exchange(code: string): Promise<CloudTokens>;
  /** Trades a refresh token for new tokens. The one passed is spent, whatever happens next. */
  refresh(refreshToken: string): Promise<Omit<CloudTokens, 'appKey'>>;
  /**
   * Relays one call. Resolves with the remote API's status and body, even a
   * 4xx or 5xx: the caller tells a 401 (refresh the token) from a failure. Rejects
   * only when the relay itself fails or refuses.
   */
  proxy(call: ProxyCall, signal?: AbortSignal): Promise<{ status: number; data: unknown }>;
}

// Token calls wait almost as long as serverless gateways allow (~150 s): giving up
// earlier could lose tokens Philips already rotated, and the connection with them.
const TOKEN_TIMEOUT_MS = 120_000;
const TRANSIENT = new Set([502, 503, 504]);
const EXPIRY_SKEW_MS = 60_000;

// What may be sent again after a 502–504, which can come after the bridge applied
// the call: a PUT sets the same state twice, while a POST would create a second
// schedule, and a repeated DELETE answers "not found" for a delete that worked.
const resendable = (method: unknown): boolean => method === 'GET' || method === 'PUT';

type TokenReply = { accessToken: string; refreshToken?: unknown; expiresIn?: unknown };

/** The fields an answer must have, and their `typeof`. */
type Shape = Readonly<Record<string, 'string' | 'number'>>;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function toExpiry(expiresIn: unknown): number {
  const seconds = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 7 * 24 * 3600;
  return Date.now() + seconds * 1000;
}

/**
 * The browser half of the cloud transport: talks to a relay created with
 * `createRelayHandler` from `hue-web/relay`, which holds your Hue app's secret.
 *
 * Every failure is a {@link HueError}. The relay's own refusals keep their
 * reason: `forbidden` when its `authorize` hook said no, as for a 401 or 403 from
 * a gateway in front of it. An answer that is not the relay's (a sign-in page
 * served by an auth proxy, a wrong URL) is `unavailable`.
 */
export function createRelayClient(options: RelayClientOptions): RelayClient {
  const fetchFn = options.fetch ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? 20_000;

  async function call<T>(payload: Json, shape: Shape, signal?: AbortSignal): Promise<T> {
    const tokenCall = payload.action === 'exchange' || payload.action === 'refresh';
    let extra: HeadersInit | undefined;
    try {
      extra = typeof options.headers === 'function' ? await options.headers() : options.headers;
    } catch (cause) {
      // Your own sign-in failed (no session, expired): the relay would refuse us anyway.
      throw new HueError('forbidden', 'Could not get the credentials your Hue relay expects.', { cause });
    }
    const headers = new Headers(extra);
    headers.set('content-type', 'application/json');
    const post = (): Promise<Response> =>
      fetchWithin(
        fetchFn,
        options.url,
        { method: 'POST', headers, body: JSON.stringify(payload) },
        tokenCall ? TOKEN_TIMEOUT_MS : timeoutMs,
      );
    let response: Response;
    try {
      response = await post();
      // 502–504 without a JSON body is the serverless gateway itself (cold start,
      // overload), not Hue: one retry. Never for token calls: they are not
      // idempotent (the refresh token rotates), a retry would present a spent one.
      // Nor for a relayed POST or DELETE: the gateway may have timed out after
      // the relay forwarded it.
      const gateway = TRANSIENT.has(response.status) && !response.headers.get('content-type')?.includes('json');
      const again = !tokenCall && (payload.action !== 'proxy' || resendable(payload.method));
      if (gateway && again && !signal?.aborted) {
        await sleepUnless(600, signal);
        throwIfAborted(signal);
        response = await post();
      }
    } catch (cause) {
      if (cause instanceof HueError) throw cause;
      throw new HueError('unreachable', 'Could not reach the Hue relay. Check the connection and try again.', {
        cause,
      });
    }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = isObject(data) && isObject(data.error) ? data.error : {};
      // Without a reason it knows, the relay did not write this answer. A 401 or
      // 403 then comes from what guards it (a gateway checking the app's session):
      // the app's sign-in is refused, not the Hue connection.
      let reason = reasonForStatus(response.status);
      if (isHueErrorReason(error.reason)) reason = error.reason;
      else if (response.status === 401 || response.status === 403) reason = 'forbidden';
      const message = typeof error.message === 'string' && error.message ? error.message : '';
      throw new HueError(reason, message || `The Hue relay answered HTTP ${response.status}.`, {
        status: response.status,
      });
    }
    // A 200 is not proof the relay answered: an auth proxy's sign-in page or the
    // app's own index.html at a wrong URL are 200s too, and would read as success.
    if (!isObject(data) || Object.entries(shape).some(([name, type]) => typeof data[name] !== type)) {
      throw new HueError('unavailable', 'Unexpected answer from the Hue relay: check its URL.', {
        status: response.status,
      });
    }
    return data as T;
  }

  return {
    async authorizeUrl(state) {
      return (await call<{ url: string }>({ action: 'auth-url', state }, { url: 'string' })).url;
    },
    async exchange(code) {
      const r = await call<TokenReply & { appKey: string }>(
        { action: 'exchange', code },
        { accessToken: 'string', appKey: 'string' },
      );
      return {
        accessToken: r.accessToken,
        refreshToken: typeof r.refreshToken === 'string' ? r.refreshToken : '',
        expiresAt: toExpiry(r.expiresIn),
        appKey: r.appKey,
      };
    },
    async refresh(refreshToken) {
      const r = await call<TokenReply>({ action: 'refresh', refreshToken }, { accessToken: 'string' });
      return {
        accessToken: r.accessToken,
        refreshToken: typeof r.refreshToken === 'string' && r.refreshToken ? r.refreshToken : refreshToken,
        expiresAt: toExpiry(r.expiresIn),
      };
    },
    async proxy(c, signal) {
      const r = await call<{ status: number; data?: unknown }>({ action: 'proxy', ...c }, { status: 'number' }, signal);
      return { status: r.status, data: r.data };
    },
  };
}

/** The cloud transport, plus what only the cloud can do. */
export interface CloudTransport extends HueTransport {
  readonly kind: 'cloud';
  /**
   * Presses the bridge's link button remotely: for 30 s the bridge accepts new
   * keys, exactly as after a physical press.
   */
  pressLinkButton(): Promise<void>;
  /** The application key the relay created, or `null` when not connected. */
  appKey(): Promise<string | null>;
}

/** Options of {@link createCloudTransport}. */
export interface CloudTransportOptions {
  /** How to reach your relay: see {@link createRelayClient}. */
  relay: RelayClient;
  /** Where the tokens live. Rotated tokens are written back to it. */
  tokens: TokenStore;
}

function cloudMessage(status: number, detail: string): string {
  const base =
    status === 429
      ? 'The Hue cloud is rate-limiting requests. Wait a few seconds and try again.'
      : TRANSIENT.has(status)
        ? 'The bridge does not answer through the Hue cloud: it may be off, or the home connection down.'
        : status === 401 || status === 403
          ? 'The Hue cloud session expired or was refused. Connect again.'
          : status === 404
            ? 'Not found on the bridge (it may have been removed).'
            : `The Hue cloud refused the request (HTTP ${status}).`;
  return detail ? `${base} (${detail})` : base;
}

// One refresh at a time per token store: the refresh token rotates on use, so two
// concurrent refreshes would have the second present an already spent token.
const refreshing = new WeakMap<TokenStore, Promise<CloudTokens>>();
// Last tokens rotated per store, and the refresh tokens this page spent: when a
// store cannot save, every transport of the page on that store must see the
// rotated tokens, not the spent ones it still holds. Tokens saved by another tab
// were not spent here, so they win. So does an empty store: a disconnect, or
// another account about to be connected, must not get this page's tokens back.
const rotated = new WeakMap<TokenStore, CloudTokens>();
const spent = new WeakMap<TokenStore, Set<string>>();
function latest(store: TokenStore, saved: CloudTokens | null): CloudTokens | null {
  const mine = rotated.get(store);
  if (!saved || !mine) return saved;
  return spent.get(store)?.has(saved.refreshToken) ? mine : saved;
}

/**
 * Browser → your relay → Philips remote API → bridge. Works from anywhere and
 * serves CLIP v2 (native effects), at the cost of latency (hundreds of ms per
 * call) and a daily quota. Prefer the local transport for effects.
 *
 * Access tokens are refreshed before they expire and on a 401. Rate limits are
 * retried with backoff, and so are transient gateway errors (502–504) for GET and
 * PUT only, as those may come after the bridge applied the call. Nothing is
 * retried for a command whose effect was stopped meanwhile.
 */
export function createCloudTransport(options: CloudTransportOptions): CloudTransport {
  const { relay, tokens } = options;
  let held: CloudTokens | null = null;

  async function saved(): Promise<CloudTokens | null> {
    try {
      return await tokens.get();
    } catch (cause) {
      throw new HueError('unavailable', 'Could not read the saved Hue cloud tokens.', { cause });
    }
  }

  async function current(): Promise<CloudTokens> {
    held ??= latest(tokens, await saved());
    if (!held) throw new HueError('unauthorized', 'Not connected to the Hue cloud.');
    return held;
  }

  async function refresh(from: CloudTokens): Promise<CloudTokens> {
    const stored = latest(tokens, await saved());
    if (!stored) {
      // Disconnected meanwhile: a refresh would write the old connection back.
      held = null;
      throw new HueError('unauthorized', 'Not connected to the Hue cloud.');
    }
    if (stored.refreshToken !== from.refreshToken && stored.expiresAt >= from.expiresAt) {
      // Already rotated elsewhere: adopt instead of spending a refresh.
      held = stored;
      if (Date.now() < stored.expiresAt - EXPIRY_SKEW_MS) return stored;
    }
    const base = held ?? from;
    let pending = refreshing.get(tokens);
    if (!pending) {
      pending = relay
        .refresh(base.refreshToken)
        .then(async (r) => {
          const next = { ...base, ...r };
          const used = spent.get(tokens) ?? new Set<string>();
          used.add(base.refreshToken);
          spent.set(tokens, used);
          // The store may have changed while the relay answered (a disconnect,
          // another account connected): it wins over the connection we refreshed.
          const now = await saved().catch(() => undefined);
          if (now === null) {
            held = null;
            throw new HueError('unauthorized', 'Not connected to the Hue cloud.');
          }
          if (now && !used.has(now.refreshToken) && now.refreshToken !== next.refreshToken) {
            held = now;
            return now;
          }
          // The refresh token just spent is dead: these are the only valid tokens
          // left. A store that cannot save them (full or blocked storage) must not
          // take the connection down with it: this page carries on from memory.
          held = next;
          rotated.set(tokens, next);
          try {
            await tokens.set(next);
          } catch {
            // Only persistence is lost, until a later save succeeds: meanwhile other
            // tabs and the next visit hold spent tokens and will have to reconnect.
          }
          return next;
        })
        .finally(() => refreshing.delete(tokens));
      refreshing.set(tokens, pending);
    }
    try {
      held = await pending;
    } catch (e) {
      // Two tabs refreshing at once present the same token, and the second is
      // refused: the first has usually saved what it got by then.
      const now = isHueError(e, 'unauthorized') ? latest(tokens, await saved().catch(() => null)) : null;
      if (!now || now.refreshToken === base.refreshToken) throw e;
      held = now;
    }
    return held;
  }

  async function raw(
    method: HueRequest['method'],
    path: (t: CloudTokens) => string,
    r: Omit<HueRequest, 'method' | 'path'>,
  ): Promise<unknown> {
    const { signal } = r;
    throwIfAborted(signal);
    let t = await current();
    if (Date.now() >= t.expiresAt - EXPIRY_SKEW_MS) {
      // Not fatal: the 401 path below takes over.
      t = await refresh(t).catch(() => t);
      throwIfAborted(signal);
    }
    const send = (tk: CloudTokens): Promise<{ status: number; data: unknown }> =>
      relay.proxy(
        { accessToken: tk.accessToken, appKey: tk.appKey, method, path: path(tk), body: r.body, v2: r.v2 === true },
        signal,
      );
    let res = await send(t);
    if (res.status === 401) {
      t = await refresh(t);
      throwIfAborted(signal);
      res = await send(t);
    }
    // Rate limits (a burst during an effect) and slow gateways: retry with backoff
    // rather than drop the command. A 429 was not applied, whatever the method.
    // Never once the owning effect is stopped: the retry would land AFTER the stop.
    const again = (status: number): boolean => status === 429 || (TRANSIENT.has(status) && resendable(method));
    for (let i = 0; again(res.status) && i < 2; i++) {
      await sleepUnless((res.status === 429 ? 900 : 500) * (i + 1), signal);
      throwIfAborted(signal);
      res = await send(t);
    }
    if (res.status >= 400) {
      throw new HueError(reasonForStatus(res.status), cloudMessage(res.status, describeErrors(res.data)), {
        status: res.status,
      });
    }
    // v1 answers 200 when it refuses (revoked key, bad value): read the body.
    if (!r.v2) {
      const err = firstError(res.data);
      if (err) throw new HueError(reasonForCode(err.type), err.description, { code: err.type });
    }
    return res.data;
  }

  const request = (r: HueRequest): Promise<unknown> =>
    raw(r.method, (t) => (r.v2 ? `/clip/v2${r.path}` : `/api/${encodeURIComponent(t.appKey)}${r.path}`), r);

  return {
    ...transportOver('cloud', 'cloud', request),
    kind: 'cloud',
    async pressLinkButton() {
      // The remote API authenticates this one with the OAuth token, no app key.
      await raw('PUT', () => '/api/0/config', { body: { linkbutton: true } });
    },
    async appKey() {
      return (held ?? (await saved()))?.appKey ?? null;
    },
  };
}
