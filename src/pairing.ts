import { HueError, isHueError, reasonForCode, reasonForStatus, throwIfAborted } from './errors.js';
import { defaultFetch, fetchWithin, sleepUnless, within } from './internal/async.js';
import { firstError, parseBridgeInfo } from './parse.js';
import type { CloudTransport } from './transport/cloud.js';
import { bridgeUrl, createLocalTransport, unreachableMessage } from './transport/local.js';
import type { HueTransport } from './types.js';

/**
 * Finding the bridge and getting a key WITHOUT asking for an IP address.
 *
 * Native apps discover bridges with mDNS/SSDP; a web page has neither, and the
 * Philips discovery endpoint only allows its own origin (CORS). So hue-web uses
 * what a page does have:
 * 1. the cloud connection, if any: the bridge's config, read remotely, gives its
 *    LAN address and its id, and a bridge with another id is then skipped. That
 *    check needs the read to succeed within 8 s: when it fails or is late, any
 *    bridge that answers is used, unverified;
 * 2. addresses you remember (`hints`), e.g. where it answered last time;
 * 3. `philips-hue.local`, the bridge's mDNS name, which most systems resolve.
 *
 * One step no code can skip: the bridge presents a self-signed certificate that
 * each browser must accept once per address. Chrome (142+) also asks for local
 * network access permission.
 */

/** The bridge's default mDNS name. */
export const MDNS_HOST = 'philips-hue.local';

/** How discovery and pairing calls reach the network. */
export interface ProbeOptions {
  /** Custom `fetch`, e.g. one that trusts the bridge certificate in Node. */
  fetch?: typeof fetch;
  /** Per-request deadline. Default 2.5 s (8 s for a key request). */
  timeoutMs?: number;
}

/**
 * Asks a host for its public bridge config (no key needed). Returns the bridge
 * id, or `null` when no bridge answers there: offline, wrong address,
 * certificate not accepted yet, local network access denied, or another device
 * (one that does not say which bridge it is).
 */
export async function probeBridge(host: string, options: ProbeOptions = {}): Promise<{ id: string } | null> {
  try {
    const response = await fetchWithin(
      options.fetch ?? defaultFetch,
      `${bridgeUrl(host)}/api/0/config`,
      {},
      options.timeoutMs ?? 2500,
    );
    if (!response.ok) return null;
    // Any web server answers a 200; only a bridge says which bridge it is.
    const { id } = parseBridgeInfo(await response.json().catch(() => null));
    return id ? { id } : null;
  } catch {
    return null;
  }
}

/**
 * Does this key work on this bridge? `/groups` needs a valid key; `/config`
 * doesn't. `unreachable` also covers a host that answers but is not a bridge.
 */
export async function checkKey(
  host: string,
  appKey: string,
  options: ProbeOptions = {},
): Promise<'ok' | 'refused' | 'unreachable'> {
  const local = createLocalTransport({
    host,
    appKey,
    ...(options.fetch && { fetch: options.fetch }),
    timeoutMs: options.timeoutMs ?? 2500,
  });
  try {
    await local.request({ method: 'GET', path: '/groups' });
    return 'ok';
  } catch (e) {
    return isHueError(e, 'unauthorized') ? 'refused' : 'unreachable';
  }
}

/** Default `devicetype` sent when pairing: `<app>#<device>`. */
export const DEFAULT_DEVICE_TYPE = 'hue-web#browser';

// `<app>#<device>` within the bridge's documented limits, neither part empty. Checked
// here so a malformed value fails at once as the programming error it is, not as a
// refusal from the bridge in the middle of pairing.
const DEVICE_TYPE = /^[^#]{1,20}#[^#]{1,19}$/;

function checkDeviceType(deviceType: string): void {
  if (!DEVICE_TYPE.test(deviceType)) {
    throw new TypeError(
      `Invalid deviceType ${JSON.stringify(deviceType)}: expected "<app>#<device>", 1 to 20 and 1 to 19 characters.`,
    );
  }
}

/**
 * One key request. Resolves the new key if the link button was pressed in the
 * last 30 s; otherwise rejects with reason `link-button`. Rejects with a
 * `TypeError`, before sending anything, when `deviceType` is malformed.
 */
export async function requestKey(
  host: string,
  options: ProbeOptions & {
    /**
     * `devicetype` of the new key: `<app>#<device>`, 1 to 20 and 1 to 19
     * characters. Default {@link DEFAULT_DEVICE_TYPE}.
     */
    deviceType?: string;
  } = {},
): Promise<string> {
  const deviceType = options.deviceType ?? DEFAULT_DEVICE_TYPE;
  checkDeviceType(deviceType);
  const url = `${bridgeUrl(host)}/api`;
  let response: Response;
  try {
    response = await fetchWithin(
      options.fetch ?? defaultFetch,
      url,
      { method: 'POST', body: JSON.stringify({ devicetype: deviceType }) },
      options.timeoutMs ?? 8000,
    );
  } catch (cause) {
    throw new HueError('unreachable', unreachableMessage(url), { cause });
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new HueError(reasonForStatus(response.status), `The bridge answered HTTP ${response.status}.`, {
      status: response.status,
    });
  }
  if (data === null) {
    throw new HueError(
      'unavailable',
      `${new URL(url).origin} does not look like a Hue bridge: it answered, but not in JSON.`,
    );
  }
  const err = firstError(data);
  if (err) throw new HueError(reasonForCode(err.type), err.description, { code: err.type });
  const key = Array.isArray(data)
    ? data
        .map((item) => (item as { success?: { username?: unknown } } | null)?.success?.username)
        .find((u) => typeof u === 'string')
    : undefined;
  if (typeof key !== 'string') throw new HueError('rejected', 'Unexpected pairing answer from the bridge.');
  return key;
}

/** No answer, or a bridge briefly in trouble: worth asking again. */
const transient = (e: unknown): boolean => isHueError(e, 'unreachable') || isHueError(e, 'unavailable');

/** How long a search waits for the cloud to say which bridge is ours. */
const IDENTITY_MS = 8000;

/** Options of {@link findBridge}. */
export interface FindBridgeOptions extends ProbeOptions {
  /** A cloud transport, to read the bridge's address and id remotely. */
  cloud?: HueTransport | null;
  /** Addresses to try first, e.g. where the bridge answered last time. */
  hints?: readonly (string | null | undefined)[];
}

/** What {@link findBridge} found. */
export interface FoundBridge {
  /** A host that answers from here, or `null`. */
  host: string | null;
  /** The bridge id, when known. */
  id: string | null;
  /**
   * The address the cloud reports, even if it does not answer from here: when
   * `host` is `null`, this is the address whose certificate the user must accept.
   */
  cloudIp: string | null;
}

/**
 * Looks for a bridge that answers from here. Hosts are probed in parallel. When
 * the cloud says which bridge is ours, only that one is returned: a bridge with
 * another id is skipped. Probes give up after `timeoutMs` (default 2.5 s); the
 * cloud read, after 8 s, and when it fails any bridge that answers is taken.
 */
export async function findBridge(options: FindBridgeOptions = {}): Promise<FoundBridge> {
  const { cloud, hints = [], timeoutMs = 2500 } = options;
  const net = { ...(options.fetch && { fetch: options.fetch }), timeoutMs };
  const probes = new Map<string, Promise<{ id: string } | null>>();
  const probe = (host: string): void => {
    if (!probes.has(host)) probes.set(host, probeBridge(host, net));
  };
  const first = [...hints, MDNS_HOST].filter((h): h is string => !!h);
  first.forEach(probe);
  // The cloud says WHICH bridge is ours: worth waiting for, or any bridge that
  // answers (a housemate's) would be taken.
  const info = cloud
    ? await within(
        cloud.getBridgeInfo().catch(() => null),
        Math.max(timeoutMs, IDENTITY_MS),
        null,
      )
    : null;
  if (info?.ip) probe(info.ip);
  // The cloud's address goes first: it is the freshest; mDNS goes last.
  const order = [...new Set([...(info?.ip ? [info.ip] : []), ...first])];
  const answers = await Promise.all(order.map((h) => probes.get(h)));
  const expected = info?.id ?? null;
  for (const [i, host] of order.entries()) {
    const answer = answers[i];
    if (answer && (!expected || answer.id === expected)) return { host, id: answer.id, cloudIp: info?.ip ?? null };
  }
  return { host: null, id: expected, cloudIp: info?.ip ?? null };
}

/** Options of {@link pairBridge}. */
export interface PairOptions extends ProbeOptions {
  /** Pair with this host instead of searching. */
  host?: string;
  /**
   * A cloud transport: used to find the bridge (and to skip any other, when its
   * id can be read within 8 s), and to pair without a physical button press.
   */
  cloud?: CloudTransport | null;
  /** Hosts to try first when searching. */
  hints?: readonly (string | null | undefined)[];
  /** Keys to try before asking for a new one (a key you saved earlier). */
  knownKeys?: readonly (string | null | undefined)[];
  /**
   * `devicetype` of a new key: `<app>#<device>`, 1 to 20 and 1 to 19 characters.
   * Default {@link DEFAULT_DEVICE_TYPE}.
   */
  deviceType?: string;
  /** Called once if, after everything else, someone has to press the link button. */
  onLinkButton?: () => void;
  /** How long to wait for that press. Default 60 s. */
  buttonTimeoutMs?: number;
  /** Stops pairing: `pairBridge` then rejects with reason `aborted`. */
  signal?: AbortSignal;
}

/** How {@link pairBridge} ended, short of an error. */
export type PairResult =
  | {
      status: 'paired';
      host: string;
      appKey: string;
      /** Which strategy produced the key. */
      via: 'known-key' | 'cloud-key' | 'remote-button' | 'link-button';
    }
  | {
      /**
       * No bridge answers from here. `candidate` is the address to open in a tab
       * (to accept its certificate) when the cloud knows it.
       */
      status: 'unreachable';
      candidate: string | null;
    }
  | { status: 'timeout'; host: string };

/**
 * Finds the bridge and gets a key, as hands-free as possible:
 * 1. a known key that still works (survives address changes);
 * 2. the cloud's own key, if the bridge accepts it locally (it is in the
 *    bridge's whitelist; not guaranteed, so it is checked);
 * 3. the link button pressed remotely through the cloud, then a local key request;
 * 4. a physical press, polled for until `buttonTimeoutMs`.
 *
 * A bridge that does not answer and a button nobody pressed are results (see
 * {@link PairResult}), not errors. Rejects only with reason `aborted` (when
 * `signal` aborts), with the bridge's own refusal when it answers a key request
 * with anything but "press the link button" (a {@link HueError}, usually reason
 * `rejected` with the v1 `code`), and with a `TypeError`, before anything is
 * sent, when `deviceType` is malformed.
 */
export async function pairBridge(options: PairOptions = {}): Promise<PairResult> {
  const { cloud = null, signal } = options;
  const cancelled = (): void => throwIfAborted(signal, 'Pairing was cancelled.');
  const deviceType = options.deviceType ?? DEFAULT_DEVICE_TYPE;
  checkDeviceType(deviceType);
  const net = {
    ...(options.fetch && { fetch: options.fetch }),
    ...(options.timeoutMs && { timeoutMs: options.timeoutMs }),
  };
  const keyOptions = { ...net, deviceType };

  let host = options.host ?? null;
  if (!host) {
    const found = await findBridge({ ...net, cloud, hints: options.hints ?? [] });
    cancelled();
    if (!found.host) return { status: 'unreachable', candidate: found.cloudIp };
    host = found.host;
  }

  const known = [...new Set((options.knownKeys ?? []).filter((k): k is string => !!k))];
  for (const appKey of known) {
    if ((await checkKey(host, appKey, net)) === 'ok') return { status: 'paired', host, appKey, via: 'known-key' };
    cancelled();
  }

  if (cloud) {
    const cloudKey = await cloud.appKey().catch(() => null);
    if (cloudKey && !known.includes(cloudKey) && (await checkKey(host, cloudKey, net)) === 'ok') {
      return { status: 'paired', host, appKey: cloudKey, via: 'cloud-key' };
    }
    cancelled();
    // Its answer doesn't matter, only whether the key request that follows succeeds.
    await cloud.pressLinkButton().catch(() => {});
    cancelled();
    try {
      return { status: 'paired', host, appKey: await requestKey(host, keyOptions), via: 'remote-button' };
    } catch (e) {
      // The remote press may not have worked: a physical one can. Any other
      // refusal would be the same after a press, so asking for one is pointless.
      if (!isHueError(e, 'link-button') && !transient(e)) throw e;
    }
  }

  options.onLinkButton?.();
  const deadline = Date.now() + (options.buttonTimeoutMs ?? 60_000);
  let misses = 0;
  while (Date.now() < deadline) {
    cancelled();
    try {
      return { status: 'paired', host, appKey: await requestKey(host, keyOptions), via: 'link-button' };
    } catch (e) {
      if (isHueError(e, 'link-button')) {
        misses = 0;
      } else if (transient(e)) {
        // A few missed answers are tolerated (Wi-Fi hiccup); a bridge gone for good is not.
        if (++misses >= 5) return { status: 'unreachable', candidate: host };
      } else {
        // The bridge answered and said no for another reason: no press will change that.
        throw e;
      }
    }
    await sleepUnless(1000, signal);
  }
  cancelled();
  return { status: 'timeout', host };
}

/**
 * Chrome's "local network access" permission (142+), when the browser exposes
 * it; `null` elsewhere. Its name changed across versions, both are tried.
 */
export async function localNetworkPermission(): Promise<PermissionStatus | null> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return null;
  for (const name of ['local-network-access', 'local-network']) {
    try {
      return await navigator.permissions.query({ name } as unknown as PermissionDescriptor);
    } catch {
      // unknown to this browser
    }
  }
  return null;
}
