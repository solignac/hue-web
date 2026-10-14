import { HueError, reasonForCode, reasonForStatus, throwIfAborted } from '../errors.js';
import { defaultFetch, fetchWithin } from '../internal/async.js';
import { describeErrors, firstError } from '../parse.js';
import type { HueRequest, HueTransport } from '../types.js';
import { transportOver } from './base.js';

/** A paired bridge: where it is, and the application key it issued. */
export interface LocalBridge {
  /** IP, hostname (`philips-hue.local`) or URL. Bare hosts are reached over HTTPS. */
  host: string;
  /** Application key the bridge issued (the v1 "username"). */
  appKey: string;
}

/** Options of {@link createLocalTransport}: the bridge, and how to reach it. */
export interface LocalTransportOptions extends LocalBridge {
  /** Custom `fetch`, e.g. one that trusts the bridge certificate in Node. */
  fetch?: typeof fetch;
  /** Per-request deadline. Default 8 s. */
  timeoutMs?: number;
}

/**
 * Base URL of a bridge. HTTPS by default: it is what lets an HTTPS page reach the
 * bridge without a mixed-content block. The price is a self-signed certificate
 * each browser must accept once. An explicit `http://` is kept as is.
 */
export function bridgeUrl(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const inBrowser = (): boolean => typeof document !== 'undefined';

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Why a bridge did not answer, with the fix the user can apply. */
export function unreachableMessage(url: string): string {
  const origin = originOf(url);
  if (origin.startsWith('http://') && inBrowser() && globalThis.location?.protocol === 'https:') {
    return `Bridge unreachable: this page is HTTPS and ${origin} is plain HTTP (mixed content). Use the bridge over HTTPS.`;
  }
  if (origin.startsWith('https://') && inBrowser()) {
    return `Bridge unreachable at ${origin}. First time? Open ${origin} in a tab and accept its certificate. Otherwise, check you are on the bridge's network.`;
  }
  return `Bridge unreachable at ${origin}. Check you are on the bridge's network.`;
}

/**
 * Browser (or Node) → bridge, over the LAN. Fast (tens of ms per command), and
 * the only way to drive effects smoothly.
 *
 * From a web page, only CLIP v1 is available: v2 needs a `hue-application-key`
 * header, which triggers a CORS preflight the bridge does not satisfy. v2 calls
 * then fail with reason `unsupported` (reads return `[]`). Outside a browser
 * there is no CORS and v2 works.
 */
export function createLocalTransport(options: LocalTransportOptions): HueTransport {
  const { host, appKey, timeoutMs = 8000 } = options;
  const fetchFn = options.fetch ?? defaultFetch;
  const base = bridgeUrl(host);
  // A failed v2 call from a page will fail forever: don't pay for it on every poll.
  let v2Blocked = false;

  async function request(r: HueRequest): Promise<unknown> {
    throwIfAborted(r.signal);
    if (r.v2 && v2Blocked) {
      throw new HueError(
        'unsupported',
        'CLIP v2 is not reachable from a web page on a local bridge. Use the cloud transport for v2 features.',
      );
    }
    const url = r.v2 ? `${base}/clip/v2${r.path}` : `${base}/api/${encodeURIComponent(appKey)}${r.path}`;
    const init: RequestInit = { method: r.method };
    // v1 bodies go without a Content-Type: no header has to pass the bridge's CORS check.
    if (r.v2) init.headers = { 'hue-application-key': appKey, 'content-type': 'application/json' };
    if (r.body !== undefined && r.method !== 'GET') init.body = JSON.stringify(r.body);

    let response: Response;
    try {
      response = await fetchWithin(fetchFn, url, init, timeoutMs);
    } catch (cause) {
      if (r.v2 && inBrowser()) {
        v2Blocked = true;
        throw new HueError(
          'unsupported',
          'CLIP v2 is not reachable from a web page on a local bridge. Use the cloud transport for v2 features.',
          { cause },
        );
      }
      throw new HueError('unreachable', unreachableMessage(url), { cause });
    }
    let data: unknown = null;
    let json = true;
    try {
      data = await response.json();
    } catch {
      json = false;
    }
    if (!response.ok) {
      const detail = describeErrors(data);
      throw new HueError(reasonForStatus(response.status), detail || `The bridge answered HTTP ${response.status}.`, {
        status: response.status,
      });
    }
    // A bridge always answers JSON. Anything else is another device at that
    // address (a router, a NAS) whose 200 would otherwise read as success.
    if (!json) {
      throw new HueError(
        'unavailable',
        `${originOf(url)} does not look like a Hue bridge: it answered, but not in JSON. Check the address.`,
        { status: response.status },
      );
    }
    if (!r.v2) {
      const err = firstError(data);
      if (err) throw new HueError(reasonForCode(err.type), err.description, { code: err.type });
    }
    return data;
  }

  return transportOver('local', host, request);
}
