import { hexToHueSat, xyToHex } from './color.js';
import type { EffectManager } from './effects/manager.js';
import { type HueError, toHueError } from './errors.js';
import { now } from './internal/async.js';
import { mergeV2 } from './parse.js';
import type { HueGroup, HueLight, HueTransport, LightState } from './types.js';

/**
 * Reads a transport's lights, merged with their CLIP v2 resources. `v2` tells
 * whether the v2 read succeeded: a failed read (429, gateway) is not "no v2".
 */
export async function readLights(transport: HueTransport): Promise<{ lights: HueLight[]; v2: boolean }> {
  const [lights, v2] = await Promise.all([
    transport.getLights(),
    transport.getV2Lights().then(
      (data) => ({ ok: true, data }),
      () => ({ ok: false, data: [] as unknown[] }),
    ),
  ]);
  return { lights: mergeV2(lights, v2.data), v2: v2.ok };
}

/** What a {@link HueStore} knows about the bridge. Replaced, never mutated, on every change. */
export interface HueSnapshot {
  readonly transport: HueTransport | null;
  readonly lights: readonly HueLight[];
  readonly groups: readonly HueGroup[];
  /** A first load or an explicit refresh is running. */
  readonly loading: boolean;
  /**
   * Why the bridge can't be read: set by a failed refresh, or two failed
   * background reads in a row; cleared by the next good read. Reason
   * `unauthorized` means pair again or reconnect the cloud; `forbidden`, sign in
   * to your own app again (its relay refused you).
   */
  readonly error: HueError | null;
  /** The last v2 read failed: v2 data shown is from the last good one. */
  readonly v2Stale: boolean;
  /** Last good read, epoch ms (0: never). */
  readonly lastSync: number;
}

/** Options of {@link createHueStore}. */
export interface HueStoreOptions {
  transport: HueTransport | null;
  /** Lets commands stop the effects driving their lights first. */
  effects?: EffectManager | undefined;
  /** Background read interval. Default: local 4 s, cloud 30 s (remote API quota). */
  pollMs?: { local?: number | undefined; cloud?: number | undefined } | undefined;
  /** A command failed. It also resolves `false`, and its optimistic state is rolled back. */
  onCommandError?: ((error: HueError) => void) | undefined;
}

/** Shared, reactive state of a bridge, and the commands that change it. */
export interface HueStore {
  getSnapshot(): HueSnapshot;
  /** Reads run in the background while someone is subscribed and the page is visible. */
  subscribe(listener: () => void): () => void;
  /** Reads lights and groups now. Resolves once the snapshot is at least as fresh as this read. */
  refresh(): Promise<void>;
  /**
   * Sets a light. Applied to the snapshot at once, then sent. Rapid calls are
   * coalesced and commands keep the order you issued them, so the last value
   * always lands. Stops an effect driving the light first, except for
   * brightness alone, which the effect adopts. Never rejects: resolves `false`
   * on failure, after rolling the snapshot back.
   */
  setLight(id: string, state: LightState): Promise<boolean>;
  /** Same as {@link HueStore.setLight} for a room or zone (`"0"`: all lights), at most once a second per group. */
  setGroup(groupId: string, state: LightState): Promise<boolean>;
  recallScene(groupId: string, sceneId: string): Promise<boolean>;
  /** PUT a CLIP v2 light resource (native effects, gradients…). Ordered, not coalesced. */
  writeV2(lightId: string, body: Record<string, unknown>): Promise<boolean>;
  /**
   * Turns everything off. With `effects`, every effect (all tabs) is stopped
   * first and given a few seconds to go silent; "off" is sent again a little
   * later in case a late command of theirs landed anyway.
   */
  allOff(): Promise<boolean>;
  /** Switches transport; state is reset and read again. Queued commands resolve `false`. */
  setTransport(transport: HueTransport | null): void;
  /** Stops reads, timers and queued commands for good. */
  destroy(): void;
}

type Fields = Record<string, unknown>;
type Waiter = { ids: readonly string[]; resolve: (ok: boolean) => void };

/** A command waiting to be sent, possibly several calls merged into one. */
interface Command {
  /** What it targets (`light:1`, `group:1`, `v2:1`): calls to the same target merge. */
  key: string;
  /** Lights it affects. Empty means unknown, which orders it against everything. */
  ids: readonly string[];
  /** The v1 state to send, or `null` for an opaque command (scene recall, v2 write). */
  state: LightState | null;
  /** Opaque, but replaces every v1 field of its lights (a scene). */
  replacesAll: boolean;
  /** Stops the effects driving its lights first. */
  stops: boolean;
  /** Which lights to stop effects on, when narrower than `ids` (an effect started since took the others). */
  stopIds?: readonly string[];
  /** Group `0`: stops effects in every tab. */
  all: boolean;
  /** Which bridge-wide rate applies. */
  rate: keyof typeof SPACING_MS;
  /** A resend of our own (the "off" confirmation): a failure is not the caller's to hear about. */
  background: boolean;
  /** Snapshot fields it set optimistically: what a failure rolls back. */
  fields: readonly string[];
  /** `writeEpoch` of the newest call merged in. */
  epoch: number;
  send: (t: HueTransport, state: LightState | null) => Promise<void>;
  waiters: Waiter[];
}

// Philips' guidance, for the whole bridge: about 10 commands a second to lights
// (they share one Zigbee network), one a second to groups (each one is
// broadcast to the whole room).
const SPACING_MS = { light: 100, group: 1000 } as const;
/** Commands on different lights may overlap in flight; never two on the same light. */
const MAX_IN_FLIGHT = 3;
const NO_STOP = { wasRunning: false, clean: true };
const COLOUR = ['hue', 'sat', 'xy', 'ct'] as const;

/** Brightness (and `on: true`) can be applied by a running effect instead of stopping it. */
const brightnessOnly = (s: LightState): boolean =>
  Object.entries(s).every(
    ([k, v]) => v === undefined || k === 'bri' || k === 'transitiontime' || (k === 'on' && v === true),
  );

const hasColor = (s: LightState): boolean => COLOUR.some((k) => s[k] !== undefined);

/** Nothing left to send: no field, or only a fade duration. */
const isMoot = (s: LightState): boolean =>
  Object.entries(s).every(([k, v]) => v === undefined || k === 'transitiontime');

/** Empty means unknown: it overlaps everything, so order is never guessed. */
const overlaps = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === 0 || b.length === 0 || a.some((id) => b.includes(id));

/**
 * Merges a newer state into a pending one. A new colour replaces the old one
 * entirely: v1 would otherwise pick by its own priority (xy > ct > hs), not by
 * recency.
 */
export function mergeState(older: LightState, newer: LightState): LightState {
  const out = { ...older };
  if (newer.xy !== undefined || newer.ct !== undefined) {
    delete out.hue;
    delete out.sat;
  }
  if (newer.xy !== undefined || newer.hue !== undefined || newer.sat !== undefined) delete out.ct;
  if (newer.ct !== undefined || newer.hue !== undefined || newer.sat !== undefined) delete out.xy;
  return { ...out, ...newer };
}

/** What is left of `older` once `newer` has applied: the fields `newer` neither sets nor overrides. */
function remainder(older: LightState, newer: LightState): LightState {
  const merged = mergeState(older, newer) as Fields;
  return Object.fromEntries(Object.entries(older).filter(([k]) => !(k in newer) && k in merged)) as LightState;
}

/** What a light will look like once `state` applies. */
function fieldsOf(s: LightState): Fields {
  const f: Fields = {};
  if (s.on !== undefined) f.on = s.on;
  if (s.bri !== undefined) f.bri = s.bri;
  if (s.xy !== undefined) {
    Object.assign(f, hexToHueSat(xyToHex(s.xy[0], s.xy[1])));
    f.colormode = 'xy';
  }
  if (s.hue !== undefined || s.sat !== undefined) {
    if (s.hue !== undefined) f.hue = s.hue;
    if (s.sat !== undefined) f.sat = s.sat;
    f.colormode = 'hs';
  }
  if (s.ct !== undefined) {
    f.ct = s.ct;
    f.colormode = 'ct';
  }
  if (s.effect !== undefined) f.effect = s.effect;
  return f;
}

/** `light` with `fields` applied; an `undefined` value removes the field. */
function patched(light: HueLight, fields: Fields): HueLight {
  const out: Fields = { ...light };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as unknown as HueLight;
}

/** Surfaces an app callback's error without letting it break the store (like an event listener's). */
function report(error: unknown): void {
  if (typeof reportError === 'function') reportError(error);
  else
    queueMicrotask(() => {
      throw error;
    });
}

const v2EffectRunning = (l: HueLight): boolean => {
  const status = (l.v2?.effects as { status?: unknown } | undefined)?.status;
  return typeof status === 'string' && status !== 'no_effect';
};

/**
 * One shared, reactive view of the bridge, for every screen of an app:
 * - background reads while subscribed and visible, one more on focus, and
 *   shortly after every command;
 * - **ordered reads**: an answer older than one already applied is dropped;
 * - **write mask**: a value just set is not overwritten by a read that left
 *   before the bridge applied it;
 * - **ordered, coalesced commands**: never two in flight on the same light, in
 *   the order they were issued; rapid changes merge, and what a newer command
 *   replaces is not sent at all;
 * - **rollback**: a refused command restores the snapshot, then re-reads;
 * - **last v2 kept** when a v2 read fails, instead of native effects vanishing.
 */
export function createHueStore(options: HueStoreOptions): HueStore {
  const { effects } = options;
  const pollMs = { local: options.pollMs?.local ?? 4000, cloud: options.pollMs?.cloud ?? 30_000 };
  const listeners = new Set<() => void>();
  /** Write mask, per light: optimistic values, what they replaced, and who set them. */
  const pending = new Map<
    string,
    { fields: Fields; base: Fields; epochs: Record<string, number>; until: number; busy: number }
  >();
  const queue: Command[] = [];
  const inFlight = new Set<Command>();
  const lastStartAt = { light: Number.NEGATIVE_INFINITY, group: Number.NEGATIVE_INFINITY };
  /** Lights whose native effect is being cleared: one clear at a time, not one per colour event. */
  const clearing = new Set<string>();
  let snap: HueSnapshot = {
    transport: options.transport,
    lights: [],
    groups: [],
    loading: false,
    error: null,
    v2Stale: false,
    lastSync: 0,
  };
  let destroyed = false;
  let transportGen = 0;
  let readGen = 0;
  let appliedGen = 0;
  let groupsGen = 0;
  let loadingReads = 0;
  let quietFailures = 0;
  let lastKick = Number.NEGATIVE_INFINITY;
  let writeEpoch = 0;
  let lastEffectId: string | null = null;
  /** `writeEpoch` when the current effect launch began: commands after it are newer than the effect. */
  let launchEpoch: number | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let gapTimer: ReturnType<typeof setTimeout> | null = null;
  let soonTimers: ReturnType<typeof setTimeout>[] = [];
  let confirmTimers: ReturnType<typeof setTimeout>[] = [];
  /** What a pending "off" confirmation covers, and since when (epoch ms). */
  let confirming: { ids: readonly string[]; since: number } | null = null;

  const set = (patch: Partial<HueSnapshot>): void => {
    snap = { ...snap, ...patch };
    for (const l of listeners) {
      try {
        l();
      } catch (e) {
        report(e); // a listener's bug must not wedge the store
      }
    }
  };
  const visible = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible';

  // ─── Reads ────────────────────────────────────────────────────────────────

  function clearPoll(): void {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll(): void {
    clearPoll();
    const t = snap.transport;
    if (destroyed || !t || listeners.size === 0 || !visible()) return;
    // A local effect gets the bridge to itself: a full read goes through the same
    // bridge as the effect's commands, which would queue behind it.
    const busy = t.kind === 'local' && effects?.getSnapshot().active?.via === 'local';
    pollTimer = setTimeout(
      () => {
        pollTimer = null;
        void load({ quiet: true });
      },
      busy ? Math.max(12_000, pollMs[t.kind]) : pollMs[t.kind],
    );
  }

  /** Each light keeps its last known v2 resource when the v2 read failed. */
  function keepLastV2(fresh: HueLight[]): HueLight[] {
    const previous = new Map(snap.lights.map((l) => [l.id, l]));
    return fresh.map((l) => {
      const p = previous.get(l.id);
      return !l.v2 && p?.v2 && p.v2Id ? { ...l, v2: p.v2, v2Id: p.v2Id } : l;
    });
  }

  function applyPending(lights: HueLight[]): HueLight[] {
    const t = now();
    return lights.map((l) => {
      const m = pending.get(l.id);
      if (!m) return l;
      if (m.busy === 0 && m.until < t) {
        pending.delete(l.id);
        return l;
      }
      return patched(l, m.fields);
    });
  }

  async function load(o: { quiet?: boolean; groups?: boolean } = {}): Promise<void> {
    const t = snap.transport;
    if (destroyed || !t) return;
    const tg = transportGen;
    const gen = ++readGen;
    if (!o.quiet && loadingReads++ === 0) set({ loading: true });
    try {
      const [read, groups] = await Promise.all([
        readLights(t),
        // Groups are not critical: a failure keeps the previous ones.
        o.groups ? t.getGroups().catch(() => null) : null,
      ]);
      if (destroyed || tg !== transportGen) return;
      const patch: { -readonly [K in keyof HueSnapshot]?: HueSnapshot[K] } = {};
      if (groups && gen > groupsGen) {
        groupsGen = gen;
        patch.groups = groups;
      }
      // Reads overlap (focus, polling, after a command): only a newer answer replaces an applied one.
      if (gen > appliedGen) {
        appliedGen = gen;
        quietFailures = 0;
        Object.assign(patch, {
          lights: applyPending(read.v2 ? read.lights : keepLastV2(read.lights)),
          v2Stale: !read.v2,
          error: null,
          lastSync: Date.now(),
        });
      }
      if (Object.keys(patch).length > 0) set(patch);
    } catch (e) {
      if (destroyed || tg !== transportGen || gen < appliedGen) return;
      const error = toHueError(e);
      quietFailures += 1;
      // One missed background read is noise; two, or a refusal, is a fact.
      const refused = error.reason === 'unauthorized' || error.reason === 'forbidden';
      if (!o.quiet || quietFailures >= 2 || refused) set({ error });
    } finally {
      if (tg === transportGen) {
        if (!o.quiet && --loadingReads === 0) set({ loading: false });
        schedulePoll();
      }
    }
  }

  /** Reads again once the bridge has settled (commands and scenes take a moment), twice to converge. */
  function refreshSoon(): void {
    for (const t of soonTimers) clearTimeout(t);
    soonTimers = destroyed ? [] : [700, 2000].map((ms) => setTimeout(() => void load({ quiet: true }), ms));
  }

  function kick(): void {
    const t = now();
    // visibilitychange and focus often fire together: one read.
    if (t - lastKick < 2000) {
      if (!pollTimer) schedulePoll();
      return;
    }
    lastKick = t;
    if (listeners.size && snap.transport && Date.now() - snap.lastSync > 3000) void load({ quiet: true, groups: true });
    else schedulePoll();
  }

  const onVisibility = (): void => (visible() ? kick() : clearPoll());

  function attach(): void {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', kick);
  }

  function detach(): void {
    clearPoll();
    if (typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', kick);
  }

  // An effect lights its targets: show it, and back off reads while it runs locally.
  const unsubscribeEffects = effects?.subscribe(() => {
    const fx = effects.getSnapshot();
    const { active } = fx;
    const launchedAt = launchEpoch;
    launchEpoch = fx.starting ? (launchEpoch ?? writeEpoch) : null;
    if (active && active.id !== lastEffectId) {
      // A new effect is a new intent: an "off" confirmation pending from an
      // earlier allOff must not black it out, nor must commands issued before
      // its launch. Commands issued during the launch are newer: they stay.
      cancelConfirm();
      const asOf = launchedAt ?? writeEpoch;
      writeEpoch += 1;
      supersedeBy(active.lightIds, asOf);
      optimistic(active.lightIds, { on: true }, 3000);
    }
    // Same for an effect started in another tab after the "off".
    const c = confirming;
    if (c && fx.elsewhere.some((e) => e.startedAt >= c.since && overlaps(e.lightIds, c.ids))) cancelConfirm();
    if ((active?.id ?? null) !== lastEffectId) {
      lastEffectId = active?.id ?? null;
      if (pollTimer) schedulePoll();
    }
  });

  // ─── Optimistic state ─────────────────────────────────────────────────────

  /** Shows the expected state at once, and shields it from reads until the bridge applies it. */
  function optimistic(ids: readonly string[], fields: Fields, holdMs = 1500): void {
    if (Object.keys(fields).length === 0) return;
    const until = now() + holdMs;
    const byId = new Map(snap.lights.map((l) => [l.id, l as unknown as Fields]));
    for (const id of ids) {
      const m = pending.get(id) ?? { fields: {}, base: {}, epochs: {}, until: 0, busy: 0 };
      for (const [k, v] of Object.entries(fields)) {
        if (!(k in m.fields)) m.base[k] = byId.get(id)?.[k];
        m.fields[k] = v;
        m.epochs[k] = writeEpoch;
      }
      m.until = Math.max(m.until, until);
      pending.set(id, m);
    }
    const touched = new Set(ids);
    set({ lights: snap.lights.map((l) => (touched.has(l.id) ? patched(l, fields) : l)) });
  }

  /** Restores what a failed command had shown, unless a newer command owns the field. */
  function rollback(c: Command): void {
    const restore = new Map<string, Fields>();
    for (const id of c.ids) {
      const m = pending.get(id);
      if (!m) continue;
      const back: Fields = {};
      for (const k of c.fields) {
        if (!(k in m.fields) || (m.epochs[k] ?? 0) > c.epoch) continue;
        back[k] = m.base[k];
        delete m.fields[k];
        delete m.base[k];
        delete m.epochs[k];
      }
      if (Object.keys(back).length > 0) restore.set(id, back);
    }
    if (restore.size > 0) {
      set({
        lights: snap.lights.map((l) => {
          const back = restore.get(l.id);
          return back ? patched(l, back) : l;
        }),
      });
    }
  }

  /** Holds (or releases) the masks of these lights while a command is pending. Returns the ids it changed. */
  function hold(ids: readonly string[], delta: 1 | -1): readonly string[] {
    const until = now() + 1000;
    const changed: string[] = [];
    for (const id of ids) {
      const m = pending.get(id);
      if (!m) continue;
      m.busy = Math.max(0, m.busy + delta);
      if (delta < 0) m.until = Math.max(m.until, until);
      changed.push(id);
    }
    return changed;
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  function cancelConfirm(): void {
    for (const t of confirmTimers) clearTimeout(t);
    confirmTimers = [];
    confirming = null;
  }

  /**
   * After stopping an effect to turn lights off, sends "off" again a bit later:
   * catches an effect command that lands anyway (another tab stopping on its
   * own, a hung request we stopped waiting for). Cancelled by any command or
   * effect started after it, and only ever sent to the transport it was meant
   * for. It goes through the queue, so it keeps its place in the order.
   */
  function confirmOff(c: Command, t: HueTransport, clean: boolean): void {
    cancelConfirm();
    confirming = { ids: c.ids, since: Date.now() };
    confirmTimers = (clean ? [2000] : [2000, 8000]).map((ms) =>
      setTimeout(() => {
        if (destroyed || writeEpoch !== c.epoch || t !== snap.transport) return;
        void enqueue({
          key: c.key,
          ids: c.ids,
          state: c.state,
          replacesAll: false,
          stops: false,
          all: false,
          rate: c.rate,
          background: true,
          fields: [],
          send: c.send,
        });
      }, ms),
    );
  }

  async function deliver(c: Command): Promise<boolean> {
    const t = snap.transport;
    if (destroyed || !t) return false;
    let stopped = NO_STOP;
    if (effects && c.stops) {
      cancelConfirm();
      // Waits for this tab's effect and for the other tabs' (bounded).
      stopped = await (c.all ? effects.stopAll() : effects.stopTouching(c.stopIds ?? c.ids));
    }
    if (destroyed || t !== snap.transport) return false;
    try {
      await c.send(t, c.state);
      settleBase(c);
      if (c.state?.on === false && stopped.wasRunning && t === snap.transport) confirmOff(c, t, stopped.clean);
      return true;
    } catch (e) {
      const error = toHueError(e);
      if (error.reason !== 'aborted' && !c.background) {
        rollback(c);
        try {
          options.onCommandError?.(error);
        } catch (thrown) {
          report(thrown);
        }
      }
      return false;
    } finally {
      refreshSoon();
    }
  }

  /** The bridge now holds what `c` set: that is what a later failure must roll back to. */
  function settleBase(c: Command): void {
    if (!c.state) return;
    const sent = fieldsOf(c.state);
    for (const id of c.ids) {
      const m = pending.get(id);
      if (!m) continue;
      for (const k of c.fields) if (k in sent && k in m.base) m.base[k] = sent[k];
    }
  }

  async function run(c: Command): Promise<void> {
    inFlight.add(c);
    let ok = false;
    try {
      ok = await deliver(c);
    } catch {
      // deliver() contains its own failures; whatever escapes still settles the callers below.
    } finally {
      inFlight.delete(c);
      for (const w of c.waiters) {
        hold(w.ids, -1);
        w.resolve(ok);
      }
      schedule();
    }
  }

  /** Starts every queued command that may go: no earlier command on its lights, its rate respected, a slot free. */
  function schedule(): void {
    if (gapTimer) clearTimeout(gapTimer);
    gapTimer = null;
    if (destroyed) return;
    let soonest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < queue.length && inFlight.size < MAX_IN_FLIGHT; ) {
      const c = queue[i] as Command;
      const blocked =
        [...inFlight].some((f) => overlaps(f.ids, c.ids)) || queue.slice(0, i).some((e) => overlaps(e.ids, c.ids));
      const wait = lastStartAt[c.rate] + SPACING_MS[c.rate] - now();
      if (blocked || wait > 0) {
        if (!blocked) soonest = Math.min(soonest, wait);
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      lastStartAt[c.rate] = now();
      void run(c);
    }
    if (soonest !== Number.POSITIVE_INFINITY) gapTimer = setTimeout(schedule, soonest);
  }

  /**
   * Queues a command. Before that, what it replaces in older queued commands
   * (fully covering their lights) is dropped from them: an "off" or a scene
   * makes them moot. Then it merges into its target's queued command, unless a
   * later command on the same lights sits in between (that would reorder them).
   */
  function enqueue(c: Omit<Command, 'epoch' | 'waiters'>): Promise<boolean> {
    if (destroyed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiters: Waiter[] = [{ ids: hold(c.ids, 1), resolve }];
      // What a superseded command meant to do travels with the one replacing it:
      // an "off" overtaken by an "on" still stops the effects first.
      let { stops, all, stopIds } = c;
      const fields = new Set(c.fields);
      for (const q of [...queue]) {
        if (!q.state || q.ids.length === 0 || !q.ids.every((id) => c.ids.includes(id))) continue;
        const rest = c.replacesAll || c.state?.on === false ? {} : c.state ? remainder(q.state, c.state) : q.state;
        if (isMoot(rest)) {
          queue.splice(queue.indexOf(q), 1);
          waiters.push(...q.waiters); // superseded: they share this command's outcome
          if (q.stops && !stops) stopIds = [...new Set([...(stopIds ?? []), ...(q.stopIds ?? q.ids)])];
          stops ||= q.stops;
          all ||= q.all;
          for (const f of q.fields) fields.add(f);
        } else {
          q.state = rest;
        }
      }
      let at = queue.length - 1;
      while (at >= 0 && queue[at]?.key !== c.key) at -= 1;
      const target = at >= 0 ? queue[at] : undefined;
      const ids = target ? [...new Set([...target.ids, ...c.ids])] : c.ids;
      if (target?.state && c.state && !queue.slice(at + 1).some((q) => overlaps(q.ids, ids))) {
        target.state = mergeState(target.state, c.state);
        if (target.stopIds || stopIds) {
          const stopping = (x: { stops: boolean; stopIds?: readonly string[] | undefined }, all: readonly string[]) =>
            x.stops ? (x.stopIds ?? all) : [];
          target.stopIds = [...new Set([...stopping(target, target.ids), ...stopping({ stops, stopIds }, c.ids)])];
        }
        target.ids = ids;
        target.fields = [...new Set([...target.fields, ...fields])];
        target.stops ||= stops;
        target.all ||= all;
        target.background &&= c.background;
        target.epoch = writeEpoch;
        target.waiters.push(...waiters);
      } else {
        queue.push({ ...c, stops, all, ...(stopIds && { stopIds }), fields: [...fields], epoch: writeEpoch, waiters });
      }
      schedule();
    });
  }

  /**
   * An effect started on these lights, newer than the queued commands issued up
   * to `asOf`: those it fully covers are moot (a v2 write is not: a native
   * effect outlives ours), and the others must not stop it. They still stop
   * what runs on their other lights.
   */
  function supersedeBy(ids: readonly string[], asOf: number): void {
    for (const q of [...queue]) {
      if (q.epoch > asOf || !overlaps(q.ids, ids)) continue;
      const moot = (q.state !== null || q.replacesAll) && q.ids.length > 0 && q.ids.every((id) => ids.includes(id));
      if (moot) {
        queue.splice(queue.indexOf(q), 1);
        for (const w of q.waiters) {
          hold(w.ids, -1);
          w.resolve(true);
        }
      } else if (q.stops) {
        const rest = (q.all ? lightIdsOf('0') : (q.stopIds ?? q.ids)).filter((id) => !ids.includes(id));
        q.all = false;
        if (rest.length > 0) q.stopIds = rest;
        else q.stops = false;
      }
    }
  }

  const lightIdsOf = (groupId: string): readonly string[] =>
    groupId === '0' ? snap.lights.map((l) => l.id) : (snap.groups.find((g) => g.id === groupId)?.lightIds ?? []);

  /** A colour set by hand replaces native animations: colorloop would ignore it, a v2 effect would keep running. */
  function clearAnimations(ids: readonly string[], state: LightState): LightState {
    if (!hasColor(state) || state.effect !== undefined) return state;
    const lights = snap.lights.filter((l) => ids.includes(l.id));
    for (const l of lights) {
      // Once per light: a colour drag fires dozens of events before the next read.
      if (!l.v2Id || !l.v2 || !v2EffectRunning(l) || clearing.has(l.id)) continue;
      const v2Id = l.v2Id;
      clearing.add(l.id);
      optimistic([l.id], { v2: { ...l.v2, effects: { ...(l.v2.effects as object), status: 'no_effect' } } });
      void enqueue({
        key: `v2:${l.id}`,
        ids: [l.id],
        state: null,
        replacesAll: false,
        stops: false,
        all: false,
        rate: 'light',
        background: false,
        fields: [],
        send: (t) => t.writeV2(v2Id, { effects: { effect: 'no_effect' } }),
      }).finally(() => clearing.delete(l.id));
    }
    return lights.some((l) => l.effect === 'colorloop') ? { ...state, effect: 'none' } : state;
  }

  function command(
    key: string,
    ids: readonly string[],
    state: LightState,
    rate: Command['rate'],
    send: Command['send'],
  ): Promise<boolean> {
    writeEpoch += 1;
    const fields = fieldsOf(state);
    optimistic(ids, fields);
    // An effect adopts a new brightness instead of being stopped by it.
    if (brightnessOnly(state) && state.bri !== undefined) effects?.setBrightness(ids, state.bri);
    return enqueue({
      key,
      ids,
      state,
      replacesAll: false,
      stops: !brightnessOnly(state),
      all: key === 'group:0',
      rate,
      background: false,
      fields: Object.keys(fields),
      send,
    });
  }

  function opaque(
    key: string,
    ids: readonly string[],
    replacesAll: boolean,
    rate: Command['rate'],
    send: Command['send'],
  ): Promise<boolean> {
    writeEpoch += 1;
    return enqueue({
      key,
      ids,
      state: null,
      replacesAll,
      stops: true,
      all: false,
      rate,
      background: false,
      fields: [],
      send,
    });
  }

  function dropQueued(): void {
    for (const c of queue.splice(0)) for (const w of c.waiters) w.resolve(false);
    if (gapTimer) clearTimeout(gapTimer);
    gapTimer = null;
  }

  function setGroup(groupId: string, state: LightState): Promise<boolean> {
    const ids = lightIdsOf(groupId);
    const s = clearAnimations(ids, state);
    return command(`group:${groupId}`, ids, s, 'group', (t, x) => t.setGroup(groupId, x ?? s));
  }

  return {
    getSnapshot: () => snap,
    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener);
      if (listeners.size === 1) {
        attach();
        if (snap.transport && Date.now() - snap.lastSync > 5000)
          void load({ groups: true, quiet: snap.lights.length > 0 });
        else schedulePoll();
      }
      return () => {
        if (listeners.delete(listener) && listeners.size === 0) detach();
      };
    },
    refresh: () => load({ groups: true }),
    setLight(id, state) {
      const s = clearAnimations([id], state);
      return command(`light:${id}`, [id], s, 'light', (t, x) => t.setLight(id, x ?? s));
    },
    setGroup,
    recallScene: (groupId, sceneId) =>
      opaque(`group:${groupId}`, lightIdsOf(groupId), true, 'group', (t) => t.recallScene(groupId, sceneId)),
    writeV2(lightId, body) {
      const v2Id = snap.lights.find((l) => l.id === lightId)?.v2Id;
      if (!v2Id) {
        options.onCommandError?.(toHueError(new Error(`Light ${lightId} has no CLIP v2 resource on this transport.`)));
        return Promise.resolve(false);
      }
      return opaque(`v2:${lightId}`, [lightId], false, 'light', (t) => t.writeV2(v2Id, body));
    },
    allOff: () => setGroup('0', { on: false }),
    setTransport(transport) {
      transportGen += 1; // reads in flight target the old transport
      appliedGen = groupsGen = readGen;
      loadingReads = 0;
      dropQueued();
      pending.clear();
      for (const t of soonTimers) clearTimeout(t);
      cancelConfirm();
      clearPoll();
      quietFailures = 0;
      set({ transport, lights: [], groups: [], loading: false, error: null, v2Stale: false, lastSync: 0 });
      if (transport && listeners.size) void load({ groups: true });
    },
    destroy() {
      destroyed = true;
      transportGen += 1;
      dropQueued();
      for (const t of soonTimers) clearTimeout(t);
      cancelConfirm();
      detach();
      unsubscribeEffects?.();
      listeners.clear();
    },
  };
}
