import { within } from '../internal/async.js';
import type { BridgeInfo, HueTransport } from '../types.js';
import { createLocalTransport, type LocalBridge } from './local.js';

/** Options of {@link localFirst}. */
export interface LocalFirstOptions {
  /** What to use when the local bridge can't be: usually the cloud transport. */
  fallback: HueTransport;
  /** The paired bridge, if any. A function reads the latest saved one each time. */
  local: LocalBridge | null | (() => LocalBridge | null);
  /** The bridge answered at the address the cloud reports (new DHCP lease): save it. */
  onMoved?: (bridge: LocalBridge) => void;
  /** Custom `fetch` for the local bridge, e.g. one that trusts its certificate in Node. */
  fetch?: typeof fetch;
}

const PROBE_MS = 1500;
// Until the cloud has said once which bridge is ours, nothing tells a neighbour's
// bridge from ours: worth waiting for, far longer than a probe.
const FIRST_IDENTITY_MS = 8000;
const PICK_TTL_MS = 30_000;
const CLOUD_TTL_MS = 5 * 60_000;

/**
 * Returns a picker for the fastest usable transport, made for effects: the local
 * bridge when it is paired, answers and accepts its key, otherwise the fallback.
 * Once the cloud has said which bridge is the account's, a local bridge with
 * another id (moved house, a second bridge) is never used.
 *
 * The cloud's view of the bridge is read as soon as `localFirst` is called, and
 * kept once read (a bridge id never changes). Until then, a pick waits up to 8 s
 * for it; when that read fails or takes longer, a local bridge that answers is
 * used unverified, and checked again at the next pick.
 *
 * When the saved address stopped answering but the cloud reports another one,
 * that one is tried and, if it works, reported through `onMoved`. A verified
 * choice is cached 30 s; the cloud's view of the bridge, 5 min.
 */
export function localFirst(options: LocalFirstOptions): () => Promise<HueTransport> {
  const { fallback } = options;
  let cache: { key: string; transport: HueTransport; until: number } | null = null;
  let cloudRead: { p: Promise<BridgeInfo | null>; at: number } | null = null;
  let lastGood: BridgeInfo | null = null;

  const net = options.fetch ? { fetch: options.fetch } : {};

  /** The bridge id, or `null` when unreachable, refused, slow, or not a bridge. */
  const probe = (bridge: LocalBridge): Promise<string | null> => {
    const t = createLocalTransport({ ...bridge, ...net, timeoutMs: PROBE_MS });
    // `/groups` needs a valid key (`/config` answers even a refused one), `/config` says WHICH bridge.
    const read = Promise.all([t.getBridgeInfo(), t.getGroups()]).then(
      ([info]) => info.id,
      () => null,
    );
    return within(read, PROBE_MS, null);
  };

  const cloudInfo = (): Promise<BridgeInfo | null> => {
    if (fallback.kind !== 'cloud') return Promise.resolve(null);
    if (cloudRead && Date.now() - cloudRead.at < CLOUD_TTL_MS) return cloudRead.p;
    const entry = { p: Promise.resolve(lastGood), at: Date.now() };
    entry.p = fallback.getBridgeInfo().then(
      (info) => {
        if (info.id || info.ip) lastGood = info;
        return lastGood;
      },
      () => {
        if (cloudRead === entry) cloudRead = null; // a failed read is retried next time
        return lastGood;
      },
    );
    cloudRead = entry;
    return entry.p;
  };

  // Started now: the cloud takes hundreds of ms, often more, and the first pick
  // (usually an effect starting) should not be the one to wait for it.
  void cloudInfo();

  return async () => {
    if (fallback.kind === 'local') return fallback;
    const bridge = typeof options.local === 'function' ? options.local() : options.local;
    if (!bridge) return fallback;
    const key = `${bridge.host}|${bridge.appKey}`;
    if (cache && cache.key === key && Date.now() < cache.until) return cache.transport;

    // Once the id is known, a slow read falls back on it: a bridge id never changes.
    const [localId, info] = await Promise.all([
      probe(bridge),
      within(cloudInfo(), lastGood ? PROBE_MS : FIRST_IDENTITY_MS, lastGood),
    ]);
    const remoteId = info?.id ?? null;
    const usable = (id: string | null): boolean => id !== null && (remoteId === null || id === remoteId);

    let chosen: LocalBridge | null = null;
    if (usable(localId)) {
      chosen = bridge;
    } else if (info?.ip && info.ip !== bridge.host) {
      const moved = { host: info.ip, appKey: bridge.appKey };
      if (usable(await probe(moved))) {
        options.onMoved?.(moved);
        chosen = moved;
      }
    }
    if (!chosen) return fallback;
    const transport = createLocalTransport({ ...chosen, ...net });
    // Cache only a verified identity; otherwise check again next time. Under the
    // address asked for, not the one found: with a static `local`, a moved bridge
    // keeps being asked for at its old address.
    if (remoteId) cache = { key, transport, until: Date.now() + PICK_TTL_MS };
    return transport;
  };
}
