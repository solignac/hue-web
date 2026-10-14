import { isControllable } from '../capabilities.js';
import type { HueLight, HueTransport } from '../types.js';
import {
  DEFAULT_MAX_DURATION_MS,
  type Effect,
  type EffectEnd,
  type EffectHandle,
  type EndReason,
  type Pace,
  runEffect,
} from './engine.js';

/** A running effect, in this tab or another. */
export interface EffectInfo {
  /** Unique per run. */
  readonly id: string;
  /** The effect's {@link Effect.name}. */
  readonly name: string;
  /** The lights it drives (plugs and on/off-only devices left out). */
  readonly lightIds: readonly string[];
  /** The kind of transport its commands go through. */
  readonly via: HueTransport['kind'];
  /** Epoch ms. */
  readonly startedAt: number;
}

/** How an effect of this tab ended, or why it could not start. */
export interface EffectEndInfo {
  /** The effect's {@link Effect.name}. */
  readonly name: string;
  /** Why it ended; `failed` too when it could not start. */
  readonly reason: EndReason;
  /** Why, when `reason` is `failed`. */
  readonly error?: Error;
  /** Epoch ms. */
  readonly endedAt: number;
}

/** What {@link EffectManager.getSnapshot} returns. A new object on every change. */
export interface EffectsSnapshot {
  /** This tab's effect. */
  readonly active: EffectInfo | null;
  /** Name of the effect being launched (transport being picked), if any. */
  readonly starting: string | null;
  /** Effects running in other tabs of this browser. */
  readonly elsewhere: readonly EffectInfo[];
  /** How the last effect of this tab ended, or why the last start failed. */
  readonly lastEnd: EffectEndInfo | null;
  /** Average command latency of this tab's effect (ms): a slow bridge, made visible. */
  readonly latencyMs: number | null;
}

/** What a stop did. */
export interface StopResult {
  /**
   * An effect was running here, or, for {@link EffectManager.stopTouching} and
   * {@link EffectManager.stopAll}, in another tab this stop waited for.
   */
  readonly wasRunning: boolean;
  /**
   * `true` when every effect it stopped has exited AND finished its cleanup (or
   * nothing was running): nothing more will be sent by them. `false` when
   * waiting was cut short (after 5 s in their tab): a command may still land.
   */
  readonly clean: boolean;
}

/** How {@link EffectManager.start} runs an effect. */
export interface StartOptions {
  /** Target lights. Plugs and on/off-only devices are left out. */
  lights: readonly HueLight[];
  /**
   * A transport, or a function picking one (see `localFirst`). Picking happens
   * inside the launch, so a stop issued meanwhile cancels the launch.
   */
  transport: HueTransport | (() => Promise<HueTransport>);
  /** Overrides the effect's default brightness. */
  brightness?: number;
  /**
   * The effect ends with reason `expired` after this long. Default: 4 h.
   * `Infinity` (or any value that is not a finite number) means no limit.
   */
  maxDurationMs?: number;
  /** Default: the transport's (see `paceFor`). */
  pace?: Pace;
}

/** This tab's effect, one at a time, coordinated with the other tabs. See {@link createEffectManager}. */
export interface EffectManager {
  /** The current state. Stable between changes, so it suits `useSyncExternalStore`. */
  getSnapshot(): EffectsSnapshot;
  /** Calls `listener` after every change of the snapshot. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Stops the current effect (and waits for its barrier), picks the transport,
   * starts. Resolves `true` if the effect started; a stop or another start in
   * the meantime cancels it, so no loop is ever orphaned. So do a later start in
   * another tab on one of its lights, and a command to one of them from another
   * tab's store.
   *
   * Resolves `false` at once, leaving the current effect running, when no
   * target can be driven (none given, or only plugs and on/off-only devices):
   * `lastEnd` then says so, with reason `failed`. And once `destroy()` was called.
   */
  start(effect: Effect, options: StartOptions): Promise<boolean>;
  /** Stops this tab's effect and any launch in progress. */
  stop(): Promise<StopResult>;
  /**
   * Stops this tab's effect and every other tab's, and resolves once all are
   * silent: past this tab's barrier, and each other tab saying its effect ended
   * (it does after its own). A tab that says nothing for 1 s is taken as closed;
   * the wait is cut short at 5.5 s, `clean` then being `false`.
   */
  stopAll(): Promise<StopResult>;
  /**
   * Stops any effect (here or in another tab) driving one of these lights, and
   * waits for it as {@link EffectManager.stopAll} does: a command sent next is
   * not overwritten by a late frame.
   */
  stopTouching(lightIds: readonly string[]): Promise<StopResult>;
  /**
   * Adjusts live the brightness of the effect driving one of these lights, here
   * or in another tab (whose next frame would otherwise overwrite a brightness
   * command). Returns `true` when this tab's effect adopted it, the launch in
   * progress here will start with it, or it was handed to another tab's effect;
   * `false` when no known effect drives these lights.
   */
  setBrightness(lightIds: readonly string[], bri: number): boolean;
  /** Lights driven by a known effect, here or in another tab. */
  drivenLights(): ReadonlySet<string>;
  /** Clears `lastEnd`, once the UI has shown it. */
  dismissEnd(): void;
  /** Stops this tab's effect and releases the channel. */
  destroy(): Promise<void>;
}

/** Options of {@link createEffectManager}. */
export interface EffectManagerOptions {
  /**
   * BroadcastChannel name the tabs coordinate on, or `false`. Default `hue-web`.
   * Tabs know lights by their v1 id only, which every bridge numbers from 1: give
   * each bridge its own channel, e.g. `hue-web:${id}` with the id from
   * `transport.getBridgeInfo()`, or effects on two bridges stop each other.
   */
  channel?: string | false;
}

type Message =
  | { tab: string; type: 'hello' }
  // `unclean`: the stop that ended its effect gave up waiting for it (a command may still land).
  | { tab: string; type: 'state'; effect: EffectInfo | null; expiresAt: number; unclean?: boolean }
  | { tab: string; type: 'stop-all' }
  // `launch`: when the start() that sent it was called (epoch ms). Absent for a command.
  | { tab: string; type: 'stop-touching'; ids: readonly string[]; launch?: number }
  | { tab: string; type: 'retune'; ids: readonly string[]; bri: number };

type StateMessage = Extract<Message, { type: 'state' }>;

const overlaps = (a: readonly string[], b: readonly string[]): boolean => a.some((id) => b.includes(id));
const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));
const NOT_RUNNING: StopResult = { wasRunning: false, clean: true };

/**
 * Creates the owner of this tab's running effect, one at a time, independently
 * of whatever UI launched it: it survives navigation, every stop goes through
 * the barrier, and its end (stopped, expired, failed) is published instead of
 * living in a UI flag that could drift.
 *
 * Across tabs of the same browser (BroadcastChannel), each tab announces its
 * effect, `stopAll` reaches the others, and starting an effect stops other tabs'
 * effects on the same lights (two loops would fight): when two tabs launch on
 * the same lights, the later start wins. A brightness change reaches the tab
 * whose effect drives the light.
 *
 * Across DEVICES there is no such channel: an effect started on a phone is only
 * known to the phone.
 *
 * One manager serves one bridge. With several, create one for each, each on its
 * own channel (see {@link EffectManagerOptions.channel}).
 */
export function createEffectManager(options: EffectManagerOptions = {}): EffectManager {
  const tab = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const listeners = new Set<() => void>();
  /** Other tabs' effects; `heard` is the hello they last answered. */
  const others = new Map<string, { effect: EffectInfo; expiresAt: number; heard: number }>();
  let hellos = 0;
  let resyncTimer: ReturnType<typeof setTimeout> | null = null;
  let snap: EffectsSnapshot = { active: null, starting: null, elsewhere: [], lastEnd: null, latencyMs: null };
  let handle: EffectHandle | null = null;
  let expiresAt = 0;
  let launchGen = 0;
  let startingIds: readonly string[] = [];
  // When the launch in progress, and the one that started the active effect, were started.
  let launchAt = 0;
  let activeLaunchAt = 0;
  // Shared: a second stop during the barrier must wait for it too, not conclude
  // "nothing was running" while a command of the effect is still in flight.
  let stopping: Promise<StopResult> | null = null;
  // What the stop under way records: `stopped` wins when a stop joins a replacement.
  let stoppingReason: 'stopped' | 'replaced' = 'stopped';
  // A brightness set during the launch, before there is an effect to adopt it.
  let launchBri: number | undefined;
  let latencyTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  const set = (patch: Partial<EffectsSnapshot>): void => {
    snap = { ...snap, ...patch };
    for (const l of listeners) l();
  };

  // ─── Across tabs ──────────────────────────────────────────────────────────

  const channel =
    options.channel !== false && typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(options.channel ?? 'hue-web')
      : null;
  const post = (m: Message): void => {
    try {
      channel?.postMessage(m);
    } catch {
      // channel closed
    }
  };
  const postState = (unclean = false): void =>
    post({ tab, type: 'state', effect: snap.active, expiresAt, ...(unclean && { unclean }) });
  /** Called with every other tab's state, by stops waiting for them. */
  const watchers = new Set<(m: StateMessage) => void>();

  /** Drops tabs whose effect has necessarily ended (a killed tab never says so). */
  const publishOthers = (): void => {
    const t = Date.now();
    for (const [id, o] of others) if (t > o.expiresAt) others.delete(id);
    set({ elsewhere: [...others.values()].map((o) => o.effect) });
  };
  /**
   * Asks the tabs again; those that don't answer within a second are dead and
   * drop out. The list is kept meanwhile: a stop issued right after must still
   * see what the other tabs are driving.
   */
  const resyncOthers = (): void => {
    const asked = ++hellos;
    post({ tab, type: 'hello' });
    if (resyncTimer) clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => {
      resyncTimer = null;
      for (const [id, o] of others) if (o.heard < asked) others.delete(id);
      publishOthers();
    }, 1000);
  };

  /**
   * Whether another tab's stop-touching overrides our launch started at `at`. A
   * command always does. Between two launches the later start wins, ties going to
   * the higher tab id, so both tabs reach the same verdict whatever order the
   * messages arrive in: yielding to every launch would make two tabs that start
   * together cancel each other.
   */
  const overrides = (m: { tab: string; launch?: number }, at: number): boolean =>
    m.launch === undefined || m.launch > at || (m.launch === at && m.tab > tab);

  const onMessage = (event: MessageEvent<Message>): void => {
    const m = event.data;
    if (!m || m.tab === tab) return;
    if (m.type === 'hello') postState();
    else if (m.type === 'stop-all') {
      cancelLaunch();
      void stopHere('stopped');
    } else if (m.type === 'stop-touching') {
      // A launch in progress counts too: it is not announced until it runs, and
      // would otherwise end up beside the other tab's effect, or overwrite the
      // command that tab's store is sending.
      if (snap.starting && overlaps(startingIds, m.ids) && overrides(m, launchAt)) cancelLaunch();
      if (snap.active && overlaps(snap.active.lightIds, m.ids) && overrides(m, activeLaunchAt)) {
        void stopHere(m.launch === undefined ? 'stopped' : 'replaced');
      }
    } else if (m.type === 'retune') {
      if (handle && snap.active && overlaps(snap.active.lightIds, m.ids)) handle.setBrightness(m.bri);
    } else if (m.type === 'state') {
      if (m.effect) others.set(m.tab, { effect: m.effect, expiresAt: m.expiresAt + 60_000, heard: hellos });
      else others.delete(m.tab);
      publishOthers();
      for (const w of watchers) w(m);
    }
  };
  const onPageHide = (): void => post({ tab, type: 'state', effect: null, expiresAt: 0 });
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') resyncOthers();
  };

  channel?.addEventListener('message', onMessage);
  if (channel && typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
  }
  post({ tab, type: 'hello' });

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  function trackLatency(h: EffectHandle | null): void {
    if (latencyTimer) clearInterval(latencyTimer);
    latencyTimer = null;
    if (snap.latencyMs !== null) set({ latencyMs: null });
    if (!h) return;
    latencyTimer = setInterval(() => {
      const ms = handle === h ? h.latency() : null;
      if (ms !== snap.latencyMs) set({ latencyMs: ms });
    }, 2000);
  }

  /** Invalidates a launch in progress: it will not start. */
  function cancelLaunch(): void {
    launchGen += 1;
    if (snap.starting) set({ starting: null });
  }

  function stopHere(reason: 'stopped' | 'replaced'): Promise<StopResult> {
    if (stopping) {
      if (reason === 'stopped') stoppingReason = reason;
      return stopping;
    }
    const h = handle;
    const info = snap.active;
    if (!h) return Promise.resolve(NOT_RUNNING);
    handle = null;
    stoppingReason = reason;
    trackLatency(null);
    // It may have ended on its own already (failed, expired) and only be finishing
    // its barrier: that end is what happened, not this stop.
    let own: EffectEnd | undefined;
    void h.done.then((e) => {
      if (e.reason !== 'stopped' && e.reason !== 'replaced') own = e;
    });
    const p = (async (): Promise<StopResult> => {
      const clean = await h.stop(reason);
      const end = own ?? { reason: stoppingReason };
      set({
        active: snap.active === info ? null : snap.active,
        lastEnd: info ? { name: info.name, ...end, endedAt: Date.now() } : snap.lastEnd,
      });
      postState(!clean);
      return { wasRunning: true, clean };
    })();
    stopping = p;
    void p.finally(() => {
      if (stopping === p) stopping = null;
    });
    return p;
  }

  /**
   * `here`, once each of the `busy` tabs (tab id → its effect's id) has said that
   * effect ended, which it does after its own barrier. A tab silent for 1 s after
   * our hello is gone (closed, killed): not waited for. Cut short at 5.5 s, past
   * that tab's own 5 s bound.
   */
  function withOthers(here: Promise<StopResult>, busy: Map<string, string>): Promise<StopResult> {
    const wasRunning = busy.size > 0;
    const silent = new Promise<boolean>((resolve) => {
      if (!wasRunning) return resolve(true);
      const heard = new Set<string>();
      let clean = true;
      const finish = (ok: boolean): void => {
        clearTimeout(gone);
        clearTimeout(cap);
        watchers.delete(watch);
        resolve(ok);
      };
      const watch = (m: StateMessage): void => {
        heard.add(m.tab);
        // Not that effect any more: ended, or a later one that started after this stop.
        if (busy.has(m.tab) && m.effect?.id !== busy.get(m.tab)) {
          busy.delete(m.tab);
          if (m.unclean) clean = false;
        }
        if (busy.size === 0) finish(clean);
      };
      const gone = setTimeout(() => {
        for (const t of busy.keys()) if (!heard.has(t)) busy.delete(t);
        if (busy.size === 0) finish(clean);
      }, 1000);
      const cap = setTimeout(() => finish(false), 5500);
      watchers.add(watch);
    });
    return Promise.all([here, silent]).then(([mine, ok]) => ({
      wasRunning: mine.wasRunning || wasRunning,
      clean: mine.clean && ok,
    }));
  }

  async function start(effect: Effect, o: StartOptions): Promise<boolean> {
    // Nothing could see or stop it any more.
    if (destroyed) return false;
    const lightIds = o.lights.filter(isControllable).map((l) => l.id);
    // Refused before anything is stopped: replacing the running effect with one
    // that ends at once would be a stop nobody asked for.
    if (lightIds.length === 0) {
      const error = new Error('No light to drive: every target is a plug or an on/off-only device.');
      set({ lastEnd: { name: effect.name, reason: 'failed', error, endedAt: Date.now() } });
      return false;
    }
    const gen = ++launchGen;
    const at = Date.now();
    launchAt = at;
    startingIds = lightIds;
    launchBri = undefined;
    set({ starting: effect.name });
    await stopHere('replaced');
    // Only for a launch still wanted: a cancelled one must not stop the effect
    // that just won over it in another tab.
    if (gen !== launchGen) return false;
    post({ tab, type: 'stop-touching', ids: lightIds, launch: at });
    let transport: HueTransport;
    try {
      transport = typeof o.transport === 'function' ? await o.transport() : o.transport;
    } catch (e) {
      if (gen === launchGen)
        set({
          starting: null,
          lastEnd: { name: effect.name, reason: 'failed', error: toError(e), endedAt: Date.now() },
        });
      return false;
    }
    if (gen !== launchGen) return false;
    // Again, now that it runs: a tab that was launching too when the first message
    // came and did not yield to it (one on an older version of this library, which
    // ignores launches) may have an effect running by now.
    post({ tab, type: 'stop-touching', ids: lightIds, launch: at });
    const maxDurationMs = o.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    const brightness = launchBri ?? o.brightness;
    const h = runEffect(effect, {
      transport,
      lights: o.lights,
      maxDurationMs,
      ...(brightness !== undefined && { brightness }),
      ...(o.pace && { pace: o.pace }),
    });
    handle = h;
    activeLaunchAt = at;
    const startedAt = Date.now();
    // Infinity when uncapped: it survives the structured clone, and other tabs then never expire the entry.
    expiresAt = startedAt + maxDurationMs;
    const info: EffectInfo = { id: `${tab}:${gen}`, name: effect.name, lightIds, via: transport.kind, startedAt };
    set({ active: info, starting: null, lastEnd: null });
    trackLatency(h);
    postState();
    void h.done.then((end) => {
      if (handle !== h) return; // already stopped (and published) by stopHere
      handle = null;
      trackLatency(null);
      set({
        active: null,
        lastEnd: { name: info.name, reason: end.reason, ...(end.error && { error: end.error }), endedAt: Date.now() },
      });
      postState();
    });
    return true;
  }

  return {
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop() {
      cancelLaunch();
      return stopHere('stopped');
    },
    stopAll() {
      const busy = new Map([...others].map(([t, o]) => [t, o.effect.id]));
      cancelLaunch();
      post({ tab, type: 'stop-all' });
      resyncOthers();
      return withOthers(stopHere('stopped'), busy);
    },
    async stopTouching(ids) {
      const busy = new Map(
        [...others].filter(([, o]) => overlaps(o.effect.lightIds, ids)).map(([t, o]) => [t, o.effect.id]),
      );
      // Posted even when no other tab is known to drive these lights: a tab still
      // launching an effect on them is not announced yet.
      post({ tab, type: 'stop-touching', ids });
      // A dead tab won't answer: it leaves the list.
      if (busy.size > 0) resyncOthers();
      if (snap.starting && overlaps(startingIds, ids)) cancelLaunch();
      const here =
        snap.active && overlaps(snap.active.lightIds, ids) ? stopHere('stopped') : Promise.resolve(NOT_RUNNING);
      return withOthers(here, busy);
    },
    setBrightness(ids, bri) {
      let adopted = false;
      if (handle && snap.active && overlaps(snap.active.lightIds, ids)) {
        handle.setBrightness(bri);
        adopted = true;
      }
      if (snap.starting && overlaps(startingIds, ids)) {
        launchBri = bri;
        adopted = true;
      }
      if (snap.elsewhere.some((e) => overlaps(e.lightIds, ids))) {
        post({ tab, type: 'retune', ids, bri });
        adopted = true;
      }
      return adopted;
    },
    drivenLights() {
      const ids = new Set(snap.active?.lightIds);
      for (const e of snap.elsewhere) for (const id of e.lightIds) ids.add(id);
      return ids;
    },
    dismissEnd() {
      if (snap.lastEnd) set({ lastEnd: null });
    },
    async destroy() {
      destroyed = true;
      cancelLaunch();
      await stopHere('stopped');
      trackLatency(null);
      if (resyncTimer) clearTimeout(resyncTimer);
      channel?.removeEventListener('message', onMessage);
      channel?.close();
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        window.removeEventListener('pagehide', onPageHide);
        document.removeEventListener('visibilitychange', onVisibility);
      }
      listeners.clear();
    },
  };
}
