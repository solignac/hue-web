import { isControllable } from '../capabilities.js';
import { HueError } from '../errors.js';
import { now, sleepUnless, within } from '../internal/async.js';
import type { HueLight, HueTransport, LightState, SendOptions } from '../types.js';

/**
 * Why an effect ended: `stopped` by a stop, `replaced` by another effect,
 * `finished` when its loop returned, `failed` (see {@link EffectEnd.error}),
 * `expired` at its maximum duration.
 */
export type EndReason = 'stopped' | 'replaced' | 'finished' | 'failed' | 'expired';

/** How an effect ended, as {@link EffectHandle.done} reports it. */
export interface EffectEnd {
  /** Why it ended. */
  readonly reason: EndReason;
  /** Why it failed, when `reason` is `failed`. */
  readonly error?: Error;
}

/** How fast an effect may send. */
export interface Pace {
  /** Minimum gap between two sends. */
  intervalMs: number;
  /** Commands awaiting their answer at the same time. */
  maxInFlight: number;
}

/**
 * The default pace of a transport.
 *
 * Local: don't wait for each answer. At ~100–300 ms per HTTPS round trip, waiting
 * made a 6-light room take seconds to receive one frame. ~8 commands/s keeps under
 * the Zigbee guidance (~10/s), 3 in flight at most.
 *
 * Cloud: one at a time. Each call crosses the relay and the remote API, whose
 * quota punishes bursts (429): latency sets the pace.
 */
export function paceFor(kind: HueTransport['kind']): Pace {
  return kind === 'cloud' ? { intervalMs: 0, maxInFlight: 1 } : { intervalMs: 120, maxInFlight: 3 };
}

/** What an effect's {@link Effect.run} loop works with. */
export interface EffectContext {
  /** Where commands go. Send through {@link EffectContext.setLight} or {@link EffectContext.emit} to keep the pace. */
  readonly transport: HueTransport;
  /** Target lights, plugs and on/off-only devices already filtered out. */
  readonly lights: readonly HueLight[];
  /** Aborts when the effect is stopped. Pass it to anything you send. */
  readonly signal: AbortSignal;
  /** `false` once stopping: leave the loop. */
  live(): boolean;
  /** Current brightness (1–254), adjustable while the effect runs. */
  brightness(): number;
  /** Paced `transport.setLight`. */
  setLight(id: string, state: LightState): Promise<void>;
  /**
   * Sends a command at the transport's pace (see {@link paceFor}). Locally it
   * returns as soon as the command LEAVES; the stop barrier still waits for it.
   * Failures are counted: too many in a row end the effect.
   */
  emit(command: (options: SendOptions) => Promise<unknown>): Promise<void>;
  /** Sleeps, waking early on stop. */
  sleep(ms: number): Promise<void>;
  /**
   * Registers work to run once the loop has exited, e.g. turning off a native
   * effect or releasing the microphone. The stop barrier waits for it, within
   * limits (5 s). The signal has aborted by then, but what it sends through
   * {@link EffectContext.setLight} or {@link EffectContext.emit} still goes out,
   * at the pace and without a signal: await it. Pass no signal to anything it
   * sends itself.
   */
  onCleanup(fn: () => void | Promise<void>): void;
}

/** A light effect: a name and a loop. Start it with an effect manager or {@link runEffect}. */
export interface Effect {
  /** Display name, also shown to other tabs. */
  readonly name: string;
  /** Default brightness, 1–254. */
  readonly brightness?: number;
  /** The loop. It must return once `ctx.live()` is `false`; throwing before a stop ends the effect as `failed`. */
  run(ctx: EffectContext): Promise<void>;
}

/** A running effect, as {@link runEffect} returns it. */
export interface EffectHandle {
  /** Settles when the effect ends, whatever the reason. Never rejects. */
  readonly done: Promise<EffectEnd>;
  /**
   * Stops and waits for the barrier: the loop exits, the commands in flight are
   * answered, then cleanup runs. Resolves `true` when the loop exited AND cleanup
   * finished: nothing more will be sent by this effect. Resolves `false` when
   * waiting was cut short after 5 s (a request or a cleanup hangs): a command may
   * still land.
   */
  stop(reason?: 'stopped' | 'replaced'): Promise<boolean>;
  /** Changes the brightness {@link EffectContext.brightness} returns (clamped to 1–254). */
  setBrightness(bri: number): void;
  /** Recent average command latency (ms), `null` before the first answer. */
  latency(): number | null;
}

/** How {@link runEffect} runs an effect. */
export interface RunOptions {
  /** Where the effect's commands go. */
  transport: HueTransport;
  /** Target lights. Plugs and on/off-only devices are left out. */
  lights: readonly HueLight[];
  /** Overrides the effect's default brightness. */
  brightness?: number;
  /** Default: {@link paceFor} the transport. */
  pace?: Pace;
  /**
   * The effect ends with reason `expired` after this long. Default:
   * {@link DEFAULT_MAX_DURATION_MS} (4 h). `Infinity` (or any value that is not
   * a finite number) means no limit; any finite length is honoured, even beyond
   * what a single timer can wait (about 24.8 days).
   */
  maxDurationMs?: number;
  /** Consecutive failures before giving up. Default: two full rounds of lights, at least 6. */
  maxFailures?: number;
}

/** Default maximum duration of an effect: 4 h. */
export const DEFAULT_MAX_DURATION_MS: number = 4 * 60 * 60 * 1000;
const STOP_WAIT_MS = 5000;
// Timers fire at once beyond 2^31 - 1 ms (a signed 32-bit delay): longer caps are waited in chunks.
const MAX_TIMER_MS = 2 ** 31 - 1;

const clampBri = (bri: number): number => Math.min(254, Math.max(1, Math.round(bri)));

/**
 * Runs an effect. Use an effect manager to get one-at-a-time and cross-tab coordination.
 *
 * What the engine guarantees:
 * - **stop is a barrier**: `stop()` resolves once the loop has EXITED, the
 *   commands in flight are acknowledged and cleanup has run. Nothing sent
 *   afterwards can be overwritten by a late step of the effect. If a request or
 *   a cleanup hangs, `stop()` gives up after 5 s and resolves `false`.
 * - **no retry after stop**: the abort signal reaches the transport, which sends
 *   nothing more (no new command, no retry after a 429).
 * - **gives up on repeated failure**: when nothing gets through (bridge gone,
 *   quota spent, key revoked), the effect ends and says why instead of spinning.
 * - **bounded duration**: 4 h by default ({@link RunOptions.maxDurationMs}): the
 *   risk is a forgotten tab driving the lights for days. Effects keep running in
 *   background tabs, but much slower: browsers throttle timers in hidden tabs
 *   (Chrome, once a tab has been hidden for about 5 minutes, wakes chained
 *   timers about once a minute).
 */
export function runEffect(effect: Effect, options: RunOptions): EffectHandle {
  const { transport } = options;
  const lights = options.lights.filter(isControllable);
  const pace = options.pace ?? paceFor(transport.kind);
  const maxFailures = options.maxFailures ?? Math.max(6, lights.length * 2);
  const controller = new AbortController();
  const { signal } = controller;
  const inFlight = new Set<Promise<boolean>>();
  const cleanups: (() => void | Promise<void>)[] = [];
  // Widened: `end` sets it from closures, which narrowing does not follow.
  let reason = 'finished' as EndReason;
  let lastError: Error | undefined;
  let bri = clampBri(options.brightness ?? effect.brightness ?? 200);
  let failures = 0;
  let latency: number | null = null;
  let lastSendAt = Number.NEGATIVE_INFINITY;
  let lastAckAt = Number.NEGATIVE_INFINITY;
  let exited = false;
  let cleanedUp = false;
  // While cleanup runs: what it sends through the context must go out although the signal has aborted.
  let cleaning = false;

  const end = (r: EndReason): void => {
    if (signal.aborted) return;
    reason = r;
    controller.abort();
  };

  async function send(command: (o: SendOptions) => Promise<unknown>, cleanup: boolean): Promise<boolean> {
    const t0 = now();
    try {
      await command(cleanup ? {} : { signal });
      failures = 0;
      // Measured from the previous answer when it is more recent: with several
      // commands in flight, queueing behind our own isn't bridge slowness.
      const t1 = now();
      const dt = t1 - Math.max(t0, lastAckAt);
      lastAckAt = t1;
      latency = latency === null ? dt : latency * 0.8 + dt * 0.2;
      return true;
    } catch (e) {
      // Not counted for a cleanup: it would replace the error the effect ended with.
      if (cleanup || signal.aborted || (e instanceof HueError && e.reason === 'aborted')) return false;
      failures += 1;
      lastError = e instanceof Error ? e : new Error(String(e));
      if (failures >= maxFailures) end('failed');
      return false;
    }
  }

  async function emit(command: (o: SendOptions) => Promise<unknown>): Promise<void> {
    // Read at the call: a command the loop left waiting is not the cleanup's, and
    // must not go out once the signal aborts.
    const cleanup = cleaning;
    // Both conditions are checked again after every wait, and nothing awaits
    // between the last check and the send: concurrent callers (a Promise.all over
    // the lights) would otherwise all wake from the same wait and send together.
    for (;;) {
      if (signal.aborted && !(cleanup && cleaning)) return;
      if (inFlight.size >= pace.maxInFlight) {
        await Promise.race(inFlight);
        continue;
      }
      const wait = lastSendAt + pace.intervalMs - now();
      if (wait <= 0) break;
      await sleepUnless(wait, cleanup ? undefined : signal);
    }
    lastSendAt = now();
    const p = send(command, cleanup);
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    // Awaited in a cleanup: the barrier waits for the cleanup, not for what it leaves in flight.
    if (cleanup || pace.maxInFlight <= 1) await p;
  }

  const ctx: EffectContext = {
    transport,
    lights,
    signal,
    live: () => !signal.aborted,
    brightness: () => bri,
    setLight: (id, state) => emit((o) => transport.setLight(id, state, o)),
    emit,
    sleep: (ms) => sleepUnless(ms, signal),
    onCleanup: (fn) => {
      cleanups.push(fn);
    },
  };

  let cap: ReturnType<typeof setTimeout> | undefined;
  const expireIn = (ms: number): void => {
    const chunk = Math.min(ms, MAX_TIMER_MS);
    cap = setTimeout(() => (ms > chunk ? expireIn(ms - chunk) : end('expired')), chunk);
  };
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  if (Number.isFinite(maxDurationMs)) expireIn(maxDurationMs);
  const done = (async (): Promise<EffectEnd> => {
    try {
      if (lights.length > 0) await effect.run(ctx);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      end('failed');
    }
    // Ended on its own when nothing aborted yet: settled now, so a stop while the
    // last answers come back does not rewrite why. And nothing more may go out.
    end('finished');
    // The barrier also covers commands sent without awaiting their answer.
    await Promise.allSettled([...inFlight]);
    exited = true;
    clearTimeout(cap);
    cleaning = true;
    cleanedUp = await within(
      Promise.allSettled(cleanups.map(async (fn) => fn())).then(() => true),
      STOP_WAIT_MS,
      false,
    );
    cleaning = false; // past the bound: a cleanup still going sends nothing more
    return reason === 'failed' && lastError ? { reason, error: lastError } : { reason };
  })();

  return {
    done,
    stop(r = 'stopped') {
      end(r);
      // Cleanup is awaited too (bounded): a native effect turned off AFTER the
      // next effect started would turn off the new one's. And it counts: a
      // cleanup command still on its way can land after whatever comes next.
      return within(done, STOP_WAIT_MS, null).then(() => exited && cleanedUp);
    },
    setBrightness(value) {
      bri = clampBri(value);
    },
    latency: () => (latency === null ? null : Math.round(latency)),
  };
}
