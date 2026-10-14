const AUTHORIZE_URL = 'https://api.meethue.com/v2/oauth2/authorize';
const TOKEN_URL = 'https://api.meethue.com/v2/oauth2/token';
/** Mirrors the bridge: `/route/api/<key>/…` (v1) and `/route/clip/v2/…` (v2). */
const ROUTE = 'https://api.meethue.com/route';

// Longer than the client waits for a token call (120 s), so the relay is never the
// one to cut an OAuth answer short: Philips may already have rotated the refresh
// token, and an answer dropped here loses the only valid one. Still under the
// ~150 s serverless gateways allow.
const TOKEN_TIMEOUT_MS = 125_000;
// Shorter than the client's default 20 s, so the client receives the relay's
// precise error ("the remote API did not answer") rather than a timeout of its own.
const PROXY_TIMEOUT_MS = 15_000;

// `<app>#<device>` within the bridge's limits, as in pairing (not imported: the
// relay stays a standalone file).
const DEVICE_TYPE = /^[^#]{1,20}#[^#]{1,19}$/;

/** Options of {@link createRelayHandler}. */
export interface RelayOptions {
  /** Client id of your Remote API app on developers.meethue.com. Required, not empty. */
  clientId: string;
  /**
   * Its client secret, required, not empty. It never leaves the relay: keeping
   * it off the browser is the relay's job.
   */
  clientSecret: string;
  /**
   * Who may use this relay. Required: an open relay lets anyone drive your Hue
   * app's credentials. Check a session, an API key, an allow-list…
   *
   * Return `true` only when the caller is positively identified, and `false`
   * whenever identification fails or your own configuration (a secret, an
   * allow-list) is missing: an unset environment variable must lock the relay,
   * not open it. A refusal answers HTTP 403 with reason `forbidden`; a hook that
   * throws answers HTTP 500, and does not let the call through either.
   */
  authorize: (request: Request) => boolean | Promise<boolean>;
  /**
   * `devicetype` of the application key created on the bridge: `<app>#<device>`,
   * 1 to 20 and 1 to 19 characters. Default `hue-web#relay`.
   */
  deviceType?: string;
  /** `Access-Control-Allow-Origin`. Default `*`: the gate is `authorize`, not cookies. */
  allowOrigin?: string;
  /** Custom `fetch` for the calls to Philips. Default: the global one. */
  fetch?: typeof fetch;
}

type Reason = 'unauthorized' | 'forbidden' | 'rejected' | 'rate-limited' | 'unavailable' | 'unreachable';

class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly reason: Reason,
    message: string,
  ) {
    super(message);
  }
}

const METHODS = new Set(['GET', 'PUT', 'POST', 'DELETE']);

const field = (body: Record<string, unknown>, name: string): string => {
  const v = body[name];
  if (typeof v !== 'string' || !v) throw new RelayError(400, 'rejected', `Missing "${name}".`);
  return v;
};

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The server half of the cloud transport: a single Fetch API handler that keeps
 * your Hue app's client secret off the browser and relays calls to the Philips
 * remote API (which a page cannot call directly: no CORS).
 *
 * Stateless: tokens live with the client, which sends them with each call.
 * Runs anywhere `Request`/`Response` do: Deno and Supabase Edge Functions,
 * Cloudflare Workers, Vercel and Next.js route handlers, Bun, Node 22+.
 *
 * Its own failures answer `{ error: { reason, message } }` with an HTTP error
 * status, which `createRelayClient` turns into a `HueError` of that reason.
 *
 * Throws a `TypeError` when `clientId` or `clientSecret` is empty or `deviceType`
 * is malformed: a missing environment variable fails at startup, not as every
 * user being told to reconnect Hue.
 *
 * @example
 * ```ts
 * Deno.serve(createRelayHandler({ clientId, clientSecret, authorize: isSignedIn }));
 * ```
 */
export function createRelayHandler(options: RelayOptions): (request: Request) => Promise<Response> {
  const fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const deviceType = options.deviceType ?? 'hue-web#relay';
  if (!options.clientId || !options.clientSecret) {
    throw new TypeError('createRelayHandler needs a clientId and a clientSecret: is an environment variable unset?');
  }
  if (!DEVICE_TYPE.test(deviceType)) {
    throw new TypeError(
      `Invalid deviceType ${JSON.stringify(deviceType)}: expected "<app>#<device>", 1 to 20 and 1 to 19 characters.`,
    );
  }
  const basic = `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`;

  const cors = (request: Request): Record<string, string> => ({
    'access-control-allow-origin': options.allowOrigin ?? '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    // Whatever your client sends for `authorize` to check (Authorization, apikey…).
    'access-control-allow-headers':
      request.headers.get('access-control-request-headers') ?? 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'Access-Control-Request-Headers',
  });
  const json = (request: Request, body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { ...cors(request), 'content-type': 'application/json' } });

  async function tokens(
    form: Record<string, string>,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn?: number }> {
    let response: Response;
    try {
      response = await fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch {
      throw new RelayError(502, 'unreachable', 'The Hue OAuth service did not answer.');
    }
    const data = (await readJson(response)) as Record<string, unknown> | string;
    const ok = typeof data === 'object' && data !== null && typeof data.access_token === 'string';
    if (!response.ok || !ok) {
      const body = typeof data === 'string' ? data : JSON.stringify(data);
      const detail = `Hue OAuth answered HTTP ${response.status}: ${body.slice(0, 200)}`;
      // The OAuth error says whose credentials failed. This relay's own (a bad
      // deploy) must not tell every user to reconnect Hue: that cannot fix them.
      const error = typeof data === 'object' && data !== null ? data.error : undefined;
      if (error === 'invalid_client' || error === 'unauthorized_client') {
        throw new RelayError(
          502,
          'unavailable',
          `The relay's client credentials (clientId, clientSecret) were refused. ${detail}`,
        );
      }
      const refused = response.status === 400 || response.status === 401;
      throw new RelayError(refused ? 401 : 502, refused ? 'unauthorized' : 'unavailable', detail);
    }
    return {
      accessToken: data.access_token as string,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : (form.refresh_token ?? ''),
      ...(typeof data.expires_in === 'number' && { expiresIn: data.expires_in }),
    };
  }

  /** Presses the link button remotely, then asks the bridge for an application key. */
  async function createAppKey(accessToken: string): Promise<string> {
    // The remote API REQUIRES Content-Type: application/json (415 otherwise).
    const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
    let press: Response;
    let response: Response;
    try {
      press = await fetchFn(`${ROUTE}/api/0/config`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ linkbutton: true }),
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
      response = await fetchFn(`${ROUTE}/api`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ devicetype: deviceType }),
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
    } catch {
      throw new RelayError(502, 'unreachable', 'The Hue remote API did not answer while creating the application key.');
    }
    const data = await readJson(response);
    if (Array.isArray(data)) {
      for (const item of data) {
        const key = (item as { success?: { username?: unknown } } | null)?.success?.username;
        if (typeof key === 'string') return key;
      }
    }
    // A press lost to an outage comes back as "link button not pressed": still
    // the outage, which a retry can get past, not the bridge saying no.
    for (const { status } of [press, response]) {
      if (status === 429) throw new RelayError(502, 'rate-limited', 'The Hue remote API is rate-limiting requests.');
      if (status >= 500) {
        throw new RelayError(502, 'unavailable', `The Hue remote API answered HTTP ${status} while creating the key.`);
      }
    }
    throw new RelayError(
      502,
      'rejected',
      `Could not create an application key on the bridge: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  async function proxy(body: Record<string, unknown>): Promise<{ status: number; data: unknown }> {
    const accessToken = field(body, 'accessToken');
    const method = field(body, 'method').toUpperCase();
    if (!METHODS.has(method)) throw new RelayError(400, 'rejected', `Unsupported method ${method}.`);
    // Normalised first, so `..` cannot step outside the bridge routes.
    const url = new URL(`${ROUTE}${field(body, 'path')}`);
    if (url.origin !== new URL(ROUTE).origin || !/^\/route\/(api|clip\/v2)\//.test(url.pathname)) {
      throw new RelayError(400, 'rejected', 'Only bridge routes (/api/…, /clip/v2/…) can be relayed.');
    }
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    // CLIP v2 also wants the application key.
    if (body.v2 === true) headers['hue-application-key'] = field(body, 'appKey');
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) };
    if (body.body !== undefined && method !== 'GET') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body.body);
    }
    let response: Response;
    try {
      response = await fetchFn(url.toString(), init);
    } catch {
      throw new RelayError(502, 'unreachable', 'The Hue remote API did not answer.');
    }
    // The Hue status is passed through as data: the client tells a 401 (refresh
    // the token) from a failure of the relay itself.
    return { status: response.status, data: await readJson(response) };
  }

  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
    if (request.method !== 'POST') return json(request, { error: { reason: 'rejected', message: 'POST only.' } }, 405);
    try {
      // Not `unauthorized`: that one tells the app to reconnect Hue, while this
      // caller has to sign in to the app, and the Hue connection is fine.
      if (!(await options.authorize(request))) throw new RelayError(403, 'forbidden', 'Not allowed to use this relay.');
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') throw new RelayError(400, 'rejected', 'Expected a JSON body.');
      switch (body.action) {
        case 'auth-url': {
          const query = new URLSearchParams({
            client_id: options.clientId,
            response_type: 'code',
            state: field(body, 'state'),
          });
          return json(request, { url: `${AUTHORIZE_URL}?${query}` });
        }
        case 'exchange': {
          const t = await tokens({ grant_type: 'authorization_code', code: field(body, 'code') });
          return json(request, { ...t, appKey: await createAppKey(t.accessToken) });
        }
        case 'refresh':
          return json(
            request,
            await tokens({ grant_type: 'refresh_token', refresh_token: field(body, 'refreshToken') }),
          );
        case 'proxy':
          return json(request, await proxy(body));
        default:
          throw new RelayError(400, 'rejected', `Unknown action ${JSON.stringify(body.action)}.`);
      }
    } catch (e) {
      const error = e instanceof RelayError ? e : new RelayError(500, 'unavailable', 'Relay error.');
      return json(request, { error: { reason: error.reason, message: error.message } }, error.status);
    }
  };
}
