import { describe, expect, it, vi } from 'vitest';
import {
  createLocalTransport,
  type Effect,
  type EffectHandle,
  type HueTransport,
  paceFor,
  readLights,
  runEffect,
} from '../src/index.js';
import { type FakeLightInit, fakeBridge } from './fake-bridge.js';

async function setup(latencyMs = 20, lightCount?: number) {
  const bridge = fakeBridge({
    latencyMs,
    ...(lightCount !== undefined && {
      lights: Object.fromEntries(
        Array.from({ length: lightCount }, (_, i): [string, FakeLightInit] => [String(i + 1), { color: true }]),
      ),
    }),
  });
  const transport = createLocalTransport({ host: bridge.ip, appKey: 'local-key', fetch: bridge.fetch });
  const { lights } = await readLights(transport);
  bridge.log.length = 0;
  return { bridge, transport, lights };
}

/** Sets every light, forever. */
const loop: Effect = {
  name: 'loop',
  async run(ctx) {
    let bri = 1;
    while (ctx.live()) {
      for (const l of ctx.lights) {
        bri = (bri % 250) + 1;
        await ctx.setLight(l.id, { on: true, bri });
      }
    }
  },
};

const fast = { intervalMs: 5, maxInFlight: 3 };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** `true` while the effect has not ended after `ms`. */
const runningAfter = (handle: EffectHandle, ms: number): Promise<boolean> =>
  Promise.race([handle.done.then(() => false), sleep(ms).then(() => true)]);

describe('effect engine', () => {
  it('paces local without waiting for answers, cloud one at a time', () => {
    expect(paceFor('local')).toEqual({ intervalMs: 120, maxInFlight: 3 });
    expect(paceFor('cloud')).toEqual({ intervalMs: 0, maxInFlight: 1 });
  });

  it('never has more commands in flight than the pace allows', async () => {
    const { bridge, transport, lights } = await setup(40);
    const handle = runEffect(loop, { transport, lights, pace: fast });
    await new Promise((r) => setTimeout(r, 300));
    await handle.stop();
    expect(bridge.maxInFlight).toBe(3);
    expect(bridge.writes().length).toBeGreaterThan(10);
  });

  it('stop is a barrier: once it resolves, nothing else reaches the bridge', async () => {
    const { bridge, transport, lights } = await setup(60);
    const handle = runEffect(loop, { transport, lights, pace: fast });
    await new Promise((r) => setTimeout(r, 100));
    expect(bridge.pending()).toBeGreaterThan(0);
    expect(await handle.stop()).toBe(true);
    expect(bridge.pending()).toBe(0); // every command in flight was answered first
    const sent = bridge.writes().length;
    await new Promise((r) => setTimeout(r, 200));
    expect(bridge.writes().length).toBe(sent);
    expect(await handle.done).toEqual({ reason: 'stopped' });
  });

  it('runs cleanup after the loop exits, and stop waits for it', async () => {
    const { bridge, transport, lights } = await setup(10);
    const order: string[] = [];
    const effect: Effect = {
      name: 'tidy',
      async run(ctx) {
        ctx.onCleanup(async () => {
          order.push('cleanup');
          await transport.setLight('1', { on: false });
        });
        while (ctx.live()) await ctx.setLight('1', { on: true });
        order.push('exited');
      },
    };
    const handle = runEffect(effect, { transport, lights, pace: fast });
    await new Promise((r) => setTimeout(r, 50));
    await handle.stop();
    expect(order).toEqual(['exited', 'cleanup']);
    expect(bridge.writes().at(-1)?.body).toEqual({ on: false });
  });

  it('sends what a cleanup gives the context, at the pace, before stop resolves', async () => {
    const { bridge, transport, lights } = await setup(30);
    const lightsOut: Effect = {
      name: 'lights out',
      async run(ctx) {
        ctx.onCleanup(async () => {
          await ctx.emit((o) => transport.writeV2('v2-1', { effects: { effect: 'no_effect' } }, o));
          await Promise.all(ctx.lights.map((l) => ctx.setLight(l.id, { on: false })));
        });
        await ctx.emit((o) => transport.writeV2('v2-1', { effects: { effect: 'candle' } }, o));
        await Promise.all(ctx.lights.map((l) => ctx.setLight(l.id, { on: true })));
        while (ctx.live()) await ctx.sleep(60_000);
      },
    };
    const handle = runEffect(lightsOut, { transport, lights, pace: { intervalMs: 5, maxInFlight: 2 } });
    await sleep(150);
    expect(bridge.lights.get('1')?.effect).toBe('candle');
    bridge.maxInFlight = 0;
    expect(await handle.stop()).toBe(true);
    expect(bridge.pending()).toBe(0);
    expect(bridge.lights.get('1')?.effect).toBe('no_effect');
    expect(lights.map((l) => bridge.lights.get(l.id)?.state.on)).toEqual([false, false, false]);
    expect(bridge.maxInFlight).toBeLessThanOrEqual(2);
  });

  it('keeps why an effect ended when a stop comes while its last commands are answered', async () => {
    const { transport, lights } = await setup(100);
    const crash: Effect = {
      name: 'crash',
      async run(ctx) {
        await ctx.setLight('1', { on: true }); // returns once sent: the answer is still on its way
        throw new Error('lost the microphone');
      },
    };
    const handle = runEffect(crash, { transport, lights, pace: fast });
    await sleep(30);
    expect(await handle.stop()).toBe(true);
    expect(await handle.done).toEqual({ reason: 'failed', error: new Error('lost the microphone') });
  });

  it('ends with reason "failed" when nothing gets through', async () => {
    const { bridge, transport, lights } = await setup(1);
    bridge.failWrites = 1000;
    const end = await runEffect(loop, { transport, lights, pace: fast, maxFailures: 4 }).done;
    expect(end.reason).toBe('failed');
    expect(end.error?.message).toBe('invalid value');
  });

  it('ends with reason "expired" at its maximum duration', async () => {
    const { transport, lights } = await setup(1);
    const end = await runEffect(loop, { transport, lights, pace: fast, maxDurationMs: 80 }).done;
    expect(end).toEqual({ reason: 'expired' });
  });

  it('finishes at once when no light can be driven', async () => {
    const { transport, lights } = await setup(1);
    const plugsOnly = lights.map((l) => ({ ...l, product: { ...l.product, archetype: 'plug' } }));
    expect(await runEffect(loop, { transport, lights: plugsOnly }).done).toEqual({ reason: 'finished' });
  });

  it('reports a thrown error as a failure', async () => {
    const { transport, lights } = await setup(1);
    const boom: Effect = {
      name: 'boom',
      run: async () => {
        throw new Error('no microphone');
      },
    };
    const end = await runEffect(boom, { transport, lights }).done;
    expect(end.reason).toBe('failed');
    expect(end.error?.message).toBe('no microphone');
  });

  it('adopts a new brightness live and measures latency', async () => {
    const { bridge, transport, lights } = await setup(15);
    const steady: Effect = {
      name: 'steady',
      brightness: 50,
      async run(ctx) {
        while (ctx.live()) await ctx.setLight('1', { bri: ctx.brightness() });
      },
    };
    const handle = runEffect(steady, { transport, lights, pace: { intervalMs: 10, maxInFlight: 1 } });
    await new Promise((r) => setTimeout(r, 60));
    handle.setBrightness(400);
    await new Promise((r) => setTimeout(r, 60));
    await handle.stop();
    const values = bridge.writes().map((w) => (w.body as { bri: number }).bri);
    expect(values[0]).toBe(50);
    expect(values.at(-1)).toBe(254);
    expect(handle.latency()).toBeGreaterThanOrEqual(10);
  });

  it('keeps the pace when an effect sends to every light at once', async () => {
    const { bridge, transport, lights } = await setup(30, 8);
    const sentAt: number[] = [];
    const timed: HueTransport = {
      ...transport,
      setLight: (id, state, options) => {
        sentAt.push(performance.now());
        return transport.setLight(id, state, options);
      },
    };
    const fanOut: Effect = {
      name: 'fan-out',
      async run(ctx) {
        while (ctx.live()) await Promise.all(ctx.lights.map((l) => ctx.setLight(l.id, { on: true })));
      },
    };
    const handle = runEffect(fanOut, { transport: timed, lights, pace: { intervalMs: 10, maxInFlight: 3 } });
    await sleep(300);
    await handle.stop();
    expect(sentAt.length).toBeGreaterThan(8);
    expect(bridge.maxInFlight).toBeLessThanOrEqual(3);
    // 1 ms of slack: the timestamps are taken just after the engine's own clock reading.
    const gaps = sentAt.slice(1).map((t, i) => t - (sentAt[i] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(9);
  });

  it('has no maximum duration when maxDurationMs is Infinity', async () => {
    const { transport, lights } = await setup(1);
    const handle = runEffect(loop, { transport, lights, pace: fast, maxDurationMs: Number.POSITIVE_INFINITY });
    expect(await runningAfter(handle, 100)).toBe(true);
    expect(await handle.stop()).toBe(true);
    expect(await handle.done).toEqual({ reason: 'stopped' });
  });

  it('honours a maximum duration longer than a timer can wait (30 days)', async () => {
    const { transport, lights } = await setup(1);
    const handle = runEffect(loop, { transport, lights, pace: fast, maxDurationMs: 30 * 24 * 3600_000 });
    expect(await runningAfter(handle, 100)).toBe(true);
    expect(await handle.stop()).toBe(true);
    expect(await handle.done).toEqual({ reason: 'stopped' });
  });

  it('expires a 30-day effect after 30 days, not before', async () => {
    const { transport, lights } = await setup(1);
    vi.useFakeTimers();
    try {
      const idle: Effect = {
        name: 'idle',
        async run(ctx) {
          while (ctx.live()) await ctx.sleep(3600_000);
        },
      };
      const day = 24 * 3600_000;
      const handle = runEffect(idle, { transport, lights, maxDurationMs: 30 * day });
      let end: unknown = null;
      void handle.done.then((e) => {
        end = e;
      });
      await vi.advanceTimersByTimeAsync(30 * day - 1000);
      expect(end).toBeNull();
      await vi.advanceTimersByTimeAsync(2000);
      expect(end).toEqual({ reason: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop resolves true only once cleanup has finished, false when cleanup outlasts the bound', async () => {
    const { transport, lights } = await setup(1);
    vi.useFakeTimers();
    try {
      const withCleanup = (cleanupMs: number): Effect => ({
        name: 'tidy',
        async run(ctx) {
          // A cleanup command whose answer takes this long (a hung request when longer than the bound).
          ctx.onCleanup(() => new Promise((r) => setTimeout(r, cleanupMs)));
          while (ctx.live()) await ctx.sleep(60_000);
        },
      });

      const quick = runEffect(withCleanup(1000), { transport, lights });
      let quickResult: boolean | null = null;
      void quick.stop().then((r) => {
        quickResult = r;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(quickResult).toBeNull(); // still waiting for the cleanup
      await vi.advanceTimersByTimeAsync(1);
      expect(quickResult).toBe(true);

      const hung = runEffect(withCleanup(60_000), { transport, lights });
      const stopped = hung.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await stopped).toBe(false); // the loop exited, but a cleanup command may still land
    } finally {
      vi.useRealTimers();
    }
  });
});
