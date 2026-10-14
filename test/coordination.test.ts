import { afterEach, describe, expect, it } from 'vitest';
import {
  createEffectManager,
  createHueStore,
  createLocalTransport,
  type Effect,
  type EffectManager,
  type HueStore,
} from '../src/index.js';
import { type FakeBridgeOptions, fakeBridge } from './fake-bridge.js';

/** How the store, the effect manager and other tabs work together when commands and effects interleave. */

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(5);
  }
};
const pace = { intervalMs: 5, maxInFlight: 3 };
const loop: Effect = {
  name: 'loop',
  async run(ctx) {
    while (ctx.live()) for (const l of ctx.lights) await ctx.setLight(l.id, { on: true });
  },
};
const hold: Effect = {
  name: 'hold',
  async run(ctx) {
    for (const l of ctx.lights) await ctx.setLight(l.id, { on: true, bri: 77 });
    while (ctx.live()) await ctx.sleep(1000);
  },
};

function world(o: { tabs?: boolean; bridge?: FakeBridgeOptions } = {}) {
  const channel = `coordination-${Math.random()}`;
  const bridge = fakeBridge({ latencyMs: 10, ...o.bridge });
  const transport = createLocalTransport({ host: bridge.ip, appKey: 'local-key', fetch: bridge.fetch });
  const tab1 = createEffectManager({ channel: o.tabs ? channel : false });
  const tab2: EffectManager | null = o.tabs ? createEffectManager({ channel }) : null;
  const store: HueStore = createHueStore({ transport, effects: tab1, pollMs: { local: 60_000 } });
  cleanups.push(
    () => store.destroy(),
    () => tab1.destroy(),
    () => tab2?.destroy(),
  );
  return { bridge, transport, tab1, tab2, store };
}

describe('commands and another tab', () => {
  it('waits for another tab even when two stops are issued in the same tick', async () => {
    const { store, transport, tab1, tab2 } = world({ tabs: true });
    await store.refresh();
    await tab2?.start(loop, { lights: store.getSnapshot().lights, transport, pace });
    await until(() => tab1.getSnapshot().elsewhere.length === 1);
    const [a, b] = await Promise.all([tab1.stopTouching(['1']), tab1.stopTouching(['3'])]);
    expect(a.wasRunning).toBe(true);
    expect(b.wasRunning).toBe(true);
  });

  it("lands a light command issued with a room command, past the other tab's late frames", async () => {
    const { store, bridge, tab1, tab2 } = world({
      tabs: true,
      bridge: { groups: { '1': { name: 'Living', type: 'Room', lights: ['1', '2'] } } },
    });
    // The other tab's frames to light 3 are slow on the wire.
    const slow3 = createLocalTransport({
      host: bridge.ip,
      appKey: 'local-key',
      fetch: async (input, init) => {
        if (String(input).includes('/lights/3/state')) await sleep(60);
        return bridge.fetch(input, init);
      },
    });
    await store.refresh();
    await tab2?.start(loop, { lights: store.getSnapshot().lights, transport: slow3, pace });
    await until(() => tab1.getSnapshot().elsewhere.length === 1);
    await sleep(100);
    expect(await Promise.all([store.setGroup('1', { xy: [0.5, 0.4] }), store.setLight('3', { on: false })])).toEqual([
      true,
      true,
    ]);
    await sleep(300);
    expect(bridge.lights.get('3')?.state.on).toBe(false);
  });

  it("an allOff queued before a local effect still stops the other tab's effect on the other lights", async () => {
    const { store, bridge, transport, tab1, tab2 } = world({ tabs: true });
    await store.refresh();
    const lights = store.getSnapshot().lights;
    await store.setGroup('1', { ct: 300 }); // the next group command waits a second
    await tab2?.start(loop, {
      lights: lights.filter((l) => l.id === '3'),
      transport,
      pace: { intervalMs: 20, maxInFlight: 1 },
    });
    await until(() => tab1.getSnapshot().elsewhere.length === 1);
    const off = store.allOff();
    await sleep(20);
    await tab1.start(hold, { lights: lights.filter((l) => l.id !== '3'), transport, pace });
    expect(await off).toBe(true);
    await sleep(300);
    expect(tab2?.getSnapshot().active).toBeNull();
    expect(bridge.lights.get('3')?.state.on).toBe(false);
  });
});

describe('commands and a launch', () => {
  it('a command issued during a launch stops the effect, even when it had to wait its turn', async () => {
    const { store, bridge, transport, tab1 } = world();
    await store.refresh();
    await store.setGroup('1', { bri: 120 }); // the next group command waits a second
    const started = tab1.start(hold, {
      lights: store.getSnapshot().lights,
      transport: () => sleep(300).then(() => transport),
      pace,
    });
    await sleep(50);
    const off = store.setGroup('1', { on: false });
    await started;
    expect(await off).toBe(true);
    await sleep(300);
    expect(tab1.getSnapshot().active).toBeNull();
    expect([...bridge.lights.values()].every((l) => l.state.on === false)).toBe(true);
  });

  it('a native effect cleared just before an effect starts is still cleared', async () => {
    const { store, bridge, transport, tab1 } = world({
      bridge: {
        lights: { '1': { color: true, effects: ['candle'] }, '2': { color: true, effects: ['candle'] } },
      },
    });
    for (const l of bridge.lights.values()) l.effect = 'candle';
    await store.refresh();
    const clears = ['1', '2'].map((id) => store.writeV2(id, { effects: { effect: 'no_effect' } }));
    const recolour = store.setLight('2', { xy: [0.6, 0.3] });
    await tab1.start(hold, { lights: store.getSnapshot().lights, transport, pace });
    expect(await Promise.all([...clears, recolour])).toEqual([true, true, true]);
    await sleep(300);
    expect([...bridge.lights.values()].map((l) => l.effect)).toEqual(['no_effect', 'no_effect']);
  });
});
