import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEffectManager,
  createLocalTransport,
  type Effect,
  type EffectManager,
  type HueTransport,
  readLights,
} from '../src/index.js';
import { fakeBridge } from './fake-bridge.js';

const managers: EffectManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.destroy()));
});

function manager(channel: string | false = false): EffectManager {
  const m = createEffectManager({ channel });
  managers.push(m);
  return m;
}

async function setup() {
  const bridge = fakeBridge({ latencyMs: 20 });
  const transport = createLocalTransport({ host: bridge.ip, appKey: 'local-key', fetch: bridge.fetch });
  const { lights } = await readLights(transport);
  return { bridge, transport, lights };
}

const pace = { intervalMs: 5, maxInFlight: 2 };
const tagged = (name: string, log: string[]): Effect => ({
  name,
  async run(ctx) {
    log.push(`${name}:start`);
    while (ctx.live()) for (const l of ctx.lights) await ctx.setLight(l.id, { on: true });
    log.push(`${name}:exit`);
  },
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A transport picker that takes its time, like `localFirst` probing the LAN. */
const slowPick =
  (transport: HueTransport, ms: number): (() => Promise<HueTransport>) =>
  () =>
    new Promise((r) => setTimeout(() => r(transport), ms));
const until = async (check: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('effect manager', () => {
  it('runs one effect at a time: starting another waits for the first to exit', async () => {
    const { transport, lights } = await setup();
    const m = manager();
    const log: string[] = [];
    expect(await m.start(tagged('a', log), { lights, transport, pace })).toBe(true);
    expect(m.getSnapshot().active).toMatchObject({ name: 'a', via: 'local', lightIds: ['1', '2', '3'] });
    await new Promise((r) => setTimeout(r, 30));
    await m.start(tagged('b', log), { lights, transport, pace });
    expect(log).toEqual(['a:start', 'a:exit', 'b:start']);
    expect(m.getSnapshot().active?.name).toBe('b');
    await m.stop();
    expect(m.getSnapshot()).toMatchObject({ active: null, lastEnd: { name: 'b', reason: 'stopped' } });
  });

  it('cancels a launch stopped while its transport is being picked', async () => {
    const { transport, lights } = await setup();
    const m = manager();
    const log: string[] = [];
    const slowPick = () => new Promise<typeof transport>((r) => setTimeout(() => r(transport), 50));
    const launch = m.start(tagged('a', log), { lights, transport: slowPick, pace });
    expect(m.getSnapshot().starting).toBe('a');
    await m.stop();
    expect(await launch).toBe(false);
    expect(log).toEqual([]);
    expect(m.getSnapshot().starting).toBeNull();
  });

  it('stops only effects touching the given lights', async () => {
    const { transport, lights } = await setup();
    const m = manager();
    await m.start(tagged('a', []), { lights: lights.slice(0, 2), transport, pace });
    expect(await m.stopTouching(['3'])).toEqual({ wasRunning: false, clean: true });
    expect(m.drivenLights()).toEqual(new Set(['1', '2']));
    expect(await m.stopTouching(['2'])).toEqual({ wasRunning: true, clean: true });
    expect(m.getSnapshot().active).toBeNull();
  });

  it('records why an effect ended on its own', async () => {
    const { bridge, transport, lights } = await setup();
    bridge.failWrites = 1000;
    const m = manager();
    await m.start(tagged('a', []), { lights, transport, pace });
    await until(() => m.getSnapshot().active === null);
    expect(m.getSnapshot().lastEnd).toMatchObject({ name: 'a', reason: 'failed' });
    m.dismissEnd();
    expect(m.getSnapshot().lastEnd).toBeNull();
  });

  it('records a transport that could not be picked', async () => {
    const { lights } = await setup();
    const m = manager();
    const ok = await m.start(tagged('a', []), { lights, transport: () => Promise.reject(new Error('no bridge')) });
    expect(ok).toBe(false);
    expect(m.getSnapshot().lastEnd).toMatchObject({ reason: 'failed', error: new Error('no bridge') });
  });

  it('coordinates tabs: sees their effects, stops overlapping ones, and stopAll reaches them', async () => {
    const { transport, lights } = await setup();
    const channel = `test-${Math.random()}`;
    const tab1 = manager(channel);
    const tab2 = manager(channel);
    await tab1.start(tagged('a', []), { lights: lights.slice(0, 2), transport, pace });
    await until(() => tab2.getSnapshot().elsewhere.length === 1);
    expect(tab2.drivenLights()).toEqual(new Set(['1', '2']));

    await tab2.start(tagged('b', []), { lights: lights.slice(1), transport, pace });
    await until(() => tab1.getSnapshot().active === null);
    expect(tab1.getSnapshot().lastEnd).toMatchObject({ name: 'a', reason: 'replaced' });

    await tab1.stopAll();
    await until(() => tab2.getSnapshot().active === null);
    expect(tab2.getSnapshot().lastEnd?.reason).toBe('stopped');
  });

  it('adjusts the brightness of the effect driving a light', async () => {
    const { transport, lights } = await setup();
    const m = manager();
    await m.start(tagged('a', []), { lights: lights.slice(0, 1), transport, pace });
    expect(m.setBrightness(['2'], 10)).toBe(false);
    expect(m.setBrightness(['1'], 10)).toBe(true);
  });

  it('lets the last tab to start win while the first is still picking its transport', async () => {
    const { transport, lights } = await setup();
    const channel = `test-${Math.random()}`;
    const tab1 = manager(channel);
    const tab2 = manager(channel);
    const log: string[] = [];
    const first = tab1.start(tagged('a', log), { lights, transport: slowPick(transport, 80), pace });
    await sleep(20); // tab1's launch has been announced to tab2
    expect(await tab2.start(tagged('b', log), { lights: lights.slice(1), transport, pace })).toBe(true);
    expect(await first).toBe(false);
    expect(tab1.getSnapshot()).toMatchObject({ active: null, starting: null });
    await sleep(50);
    expect(log).toEqual(['b:start']);
    expect(tab2.getSnapshot().active?.name).toBe('b');
  });

  it('lets the later start win when two tabs launch at once and their messages cross', async () => {
    const { transport, lights } = await setup();
    const channel = `test-${Math.random()}`;
    const tab1 = manager(channel);
    const tab2 = manager(channel);
    const log: string[] = [];
    const first = tab1.start(tagged('a', log), { lights, transport: slowPick(transport, 50), pace });
    // A later start, before tab1's announcement can be delivered: a message needs a turn of the event loop.
    const t = Date.now();
    while (Date.now() === t);
    const second = tab2.start(tagged('b', log), { lights, transport: slowPick(transport, 50), pace });
    expect(await second).toBe(true);
    expect(await first).toBe(false);
    await sleep(50);
    expect(log).toEqual(['b:start']);
    expect(tab1.getSnapshot().active).toBeNull();
  });

  it("cancels a launch when another tab's store sends a command to one of its lights", async () => {
    const { bridge, transport, lights } = await setup();
    const channel = `test-${Math.random()}`;
    const tab1 = manager(channel);
    const tab2 = manager(channel);
    const log: string[] = [];
    bridge.log.length = 0;
    const launch = tab1.start(tagged('a', log), { lights, transport: slowPick(transport, 80), pace });
    await sleep(20);
    // What tab2's store does before sending a command to light 1: tab1's effect must not overwrite it.
    expect(await tab2.stopTouching(['1'])).toEqual({ wasRunning: false, clean: true });
    expect(await launch).toBe(false);
    await sleep(50);
    expect(log).toEqual([]);
    expect(bridge.writes()).toEqual([]);
  });

  it('hands a brightness change to the tab whose effect drives the light', async () => {
    const { bridge, transport, lights } = await setup();
    const channel = `test-${Math.random()}`;
    const tab1 = manager(channel);
    const tab2 = manager(channel);
    const steady: Effect = {
      name: 'steady',
      brightness: 50,
      async run(ctx) {
        while (ctx.live()) await ctx.setLight('1', { bri: ctx.brightness() });
      },
    };
    await tab1.start(steady, { lights: lights.slice(0, 1), transport, pace });
    await until(() => tab2.getSnapshot().elsewhere.length === 1);
    expect(tab2.setBrightness(['3'], 30)).toBe(false); // nobody drives light 3
    expect(tab2.setBrightness(['1'], 30)).toBe(true);
    await until(() => (bridge.writes().at(-1)?.body as { bri?: number } | undefined)?.bri === 30);
    expect(tab1.getSnapshot().active?.name).toBe('steady'); // adopted, not stopped
  });

  it('keeps an effect without a maximum duration running and listed in other tabs', async () => {
    const { transport, lights } = await setup();
    const channel = `test-${Math.random()}`;
    const tab1 = manager(channel);
    const tab2 = manager(channel);
    const opts = { lights, transport, pace, maxDurationMs: Number.POSITIVE_INFINITY };
    expect(await tab1.start(tagged('a', []), opts)).toBe(true);
    await until(() => tab2.getSnapshot().elsewhere.length === 1);
    await sleep(100);
    expect(tab1.getSnapshot().active?.name).toBe('a');
    // A new tab asks again: the answer (expiresAt: Infinity) must survive the expiry check.
    const tab3 = manager(channel);
    await until(() => tab3.getSnapshot().elsewhere.length === 1);
    expect(tab2.getSnapshot().elsewhere).toHaveLength(1);
    expect((await tab1.stop()).wasRunning).toBe(true);
  });

  it('refuses to start without a light to drive, and leaves the running effect alone', async () => {
    const { transport, lights } = await setup();
    const m = manager();
    const log: string[] = [];
    await m.start(tagged('a', log), { lights, transport, pace });
    const plugs = lights.map((l) => ({ ...l, product: { ...l.product, archetype: 'plug' } }));
    expect(await m.start(tagged('b', log), { lights: plugs, transport, pace })).toBe(false);
    expect(await m.start(tagged('c', log), { lights: [], transport, pace })).toBe(false);
    expect(m.getSnapshot()).toMatchObject({
      active: { name: 'a' },
      starting: null,
      lastEnd: { name: 'c', reason: 'failed', error: expect.any(Error) },
    });
    expect(m.getSnapshot().lastEnd?.error?.message).toMatch(/no light/i);
    expect(log).toEqual(['a:start']);
  });

  it('keeps why an effect ended on its own when a stop comes while it winds down', async () => {
    const { transport, lights } = await setup();
    const m = manager();
    let windingDown = false;
    const crash: Effect = {
      name: 'crash',
      async run(ctx) {
        ctx.onCleanup(async () => {
          windingDown = true;
          await sleep(100);
        });
        throw new Error('lost the microphone');
      },
    };
    expect(await m.start(crash, { lights, transport, pace })).toBe(true);
    await until(() => windingDown);
    expect(await m.stop()).toEqual({ wasRunning: true, clean: true });
    expect(m.getSnapshot().lastEnd).toMatchObject({
      name: 'crash',
      reason: 'failed',
      error: new Error('lost the microphone'),
    });
  });

  it('records a replacement cancelled by a stop as a stop', async () => {
    const { transport, lights } = await setup();
    const m = manager();
    const log: string[] = [];
    const slowExit: Effect = {
      name: 'a',
      async run(ctx) {
        ctx.onCleanup(() => sleep(100));
        while (ctx.live()) await ctx.sleep(60_000);
      },
    };
    await m.start(slowExit, { lights, transport, pace });
    const next = m.start(tagged('b', log), { lights, transport, pace }); // waits for a's barrier
    expect(await m.stop()).toEqual({ wasRunning: true, clean: true });
    expect(await next).toBe(false);
    expect(m.getSnapshot().lastEnd).toMatchObject({ name: 'a', reason: 'stopped' });
    expect(log).toEqual([]);
  });

  it("records a command from another tab's store as a stop, not a replacement", async () => {
    const { transport, lights } = await setup();
    const channel = `test-${Math.random()}`;
    const tab1 = manager(channel);
    const tab2 = manager(channel);
    await tab1.start(tagged('a', []), { lights, transport, pace });
    await until(() => tab2.getSnapshot().elsewhere.length === 1);
    await tab2.stopTouching(['1']);
    await until(() => tab1.getSnapshot().active === null);
    expect(tab1.getSnapshot().lastEnd).toMatchObject({ name: 'a', reason: 'stopped' });
  });

  it('starts nothing during or after destroy', async () => {
    const { transport, lights } = await setup();
    const m = manager();
    const log: string[] = [];
    await m.start(tagged('a', log), { lights, transport, pace });
    const destroyed = m.destroy();
    expect(await m.start(tagged('b', log), { lights, transport, pace })).toBe(false);
    await destroyed;
    expect(await m.start(tagged('c', log), { lights, transport, pace })).toBe(false);
    expect(log).toEqual(['a:start', 'a:exit']);
    expect(m.getSnapshot().active).toBeNull();
  });

  it('hands a brightness set during the launch to the effect', async () => {
    const { bridge, transport, lights } = await setup();
    const m = manager();
    bridge.log.length = 0;
    const steady: Effect = {
      name: 'steady',
      brightness: 50,
      async run(ctx) {
        while (ctx.live()) await ctx.setLight('1', { bri: ctx.brightness() });
      },
    };
    const launch = m.start(steady, { lights: lights.slice(0, 1), transport: slowPick(transport, 50), pace });
    expect(m.setBrightness(['1'], 30)).toBe(true);
    expect(await launch).toBe(true);
    await until(() => bridge.writes().length > 0);
    expect(bridge.writes()[0]?.body).toEqual({ bri: 30 });
  });

  it.each(['stopTouching', 'stopAll'] as const)(
    "%s resolves only once another tab's effect is silent",
    async (method) => {
      const { bridge, transport, lights } = await setup();
      const channel = `test-${Math.random()}`;
      const tab1 = manager(channel);
      const tab2 = manager(channel);
      await tab1.start(tagged('a', []), { lights, transport, pace });
      await until(() => tab2.getSnapshot().elsewhere.length === 1);
      bridge.latencyMs = 300; // its next frames land late
      await sleep(50);
      expect(bridge.pending()).toBeGreaterThan(0);
      const result = await (method === 'stopAll' ? tab2.stopAll() : tab2.stopTouching(['1']));
      expect(bridge.pending()).toBe(0); // every frame of tab1 landed before a command could go
      expect(result).toEqual({ wasRunning: true, clean: true });
      expect(tab1.getSnapshot().active).toBeNull();
    },
  );

  describe('with a tab that is not a manager', () => {
    const channel = `test-${Math.random()}`;
    let peer: BroadcastChannel;
    afterEach(() => peer.close());
    /** What a manager posts while its effect `peer:<n>` drives light 1. */
    const running = (n = 1) => ({
      tab: 'peer',
      type: 'state',
      effect: { id: `peer:${n}`, name: 'wave', lightIds: ['1'], via: 'local', startedAt: Date.now() },
      expiresAt: Date.now() + 60_000,
    });
    const announce = (): void => {
      peer = new BroadcastChannel(channel);
      peer.postMessage(running());
    };

    it('does not wait long for a tab that died with its effect running', async () => {
      const m = manager(channel);
      announce(); // and never answers again
      await until(() => m.getSnapshot().elsewhere.length === 1);
      const t0 = Date.now();
      expect(await m.stopTouching(['1'])).toEqual({ wasRunning: true, clean: true });
      expect(Date.now() - t0).toBeLessThan(2500);
    });

    it('waits for a tab that answers past 1 s, up to 5.5 s', async () => {
      const m = manager(channel);
      announce();
      peer.onmessage = (e: MessageEvent<{ type: string }>) => {
        if (e.data.type === 'hello') peer.postMessage(running()); // alive, its effect never ends
      };
      await until(() => m.getSnapshot().elsewhere.length === 1);
      vi.useFakeTimers();
      try {
        let result: unknown = null;
        void m.stopTouching(['1']).then((r) => {
          result = r;
        });
        await new Promise<void>((resolve) => {
          const unsubscribe = m.subscribe(() => {
            if (m.getSnapshot().elsewhere.length === 0) return;
            unsubscribe();
            resolve(); // its answer to the hello came
          });
        });
        await vi.advanceTimersByTimeAsync(5000);
        expect(result).toBeNull();
        await vi.advanceTimersByTimeAsync(500);
        expect(result).toEqual({ wasRunning: true, clean: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not wait for an effect the other tab started after the stop', async () => {
      const m = manager(channel);
      announce();
      peer.onmessage = (e: MessageEvent<{ type: string }>) => {
        if (e.data.type === 'stop-touching') peer.postMessage(running(2));
      };
      await until(() => m.getSnapshot().elsewhere.length === 1);
      expect(await m.stopTouching(['1'])).toEqual({ wasRunning: true, clean: true }); // without waiting for the cap
    });

    it("reports a stop as unclean when the other tab's barrier was cut short", async () => {
      const m = manager(channel);
      announce();
      peer.onmessage = (e: MessageEvent<{ type: string }>) => {
        if (e.data.type === 'stop-touching') {
          peer.postMessage({ tab: 'peer', type: 'state', effect: null, expiresAt: 0, unclean: true });
        }
      };
      await until(() => m.getSnapshot().elsewhere.length === 1);
      expect(await m.stopTouching(['1'])).toEqual({ wasRunning: true, clean: false });
    });

    it('tells the other tabs when its own stop was cut short', async () => {
      const { transport, lights } = await setup();
      const m = manager(channel);
      peer = new BroadcastChannel(channel);
      const said = new Promise((resolve) => {
        peer.onmessage = (e: MessageEvent<{ type: string; effect?: unknown }>) => {
          if (e.data.type === 'state' && e.data.effect === null) resolve(e.data);
        };
      });
      vi.useFakeTimers();
      try {
        const hung: Effect = {
          name: 'hung',
          async run(ctx) {
            ctx.onCleanup(() => new Promise(() => {}));
            while (ctx.live()) await ctx.sleep(60_000);
          },
        };
        expect(await m.start(hung, { lights, transport })).toBe(true);
        const stopped = m.stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(await stopped).toEqual({ wasRunning: true, clean: false });
      } finally {
        vi.useRealTimers();
      }
      expect(await said).toMatchObject({ unclean: true });
    });
  });

  it('reports a stop as unclean while a cleanup command is still pending', async () => {
    const { transport, lights } = await setup();
    const m = manager();
    vi.useFakeTimers();
    try {
      const hung: Effect = {
        name: 'hung',
        async run(ctx) {
          ctx.onCleanup(() => new Promise(() => {})); // its answer never comes
          while (ctx.live()) await ctx.sleep(60_000);
        },
      };
      expect(await m.start(hung, { lights, transport })).toBe(true);
      const stopped = m.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await stopped).toEqual({ wasRunning: true, clean: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
