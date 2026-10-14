import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEffectManager,
  createHueStore,
  createLocalTransport,
  type Effect,
  HueError,
  type HueStore,
  type HueTransport,
  mergeState,
} from '../src/index.js';
import { fakeBridge } from './fake-bridge.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const until = async (check: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function setup(
  o: { latencyMs?: number; transport?: (t: HueTransport) => HueTransport; effects?: boolean; pollMs?: number } = {},
) {
  const bridge = fakeBridge({ latencyMs: o.latencyMs ?? 5 });
  const base = createLocalTransport({ host: bridge.ip, appKey: 'local-key', fetch: bridge.fetch });
  const transport = o.transport ? o.transport(base) : base;
  const effects = o.effects ? createEffectManager({ channel: false }) : undefined;
  const errors: HueError[] = [];
  const store: HueStore = createHueStore({
    transport,
    ...(effects && { effects }),
    pollMs: { local: o.pollMs ?? 60_000 },
    onCommandError: (e) => errors.push(e),
  });
  cleanups.push(
    () => store.destroy(),
    () => effects?.destroy(),
  );
  return { bridge, transport, store, effects, errors };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const loop: Effect = {
  name: 'loop',
  async run(ctx) {
    while (ctx.live()) for (const l of ctx.lights) await ctx.setLight(l.id, { on: true });
  },
};
const light = (store: HueStore, id: string) => store.getSnapshot().lights.find((l) => l.id === id);
const bulb = (bridge: ReturnType<typeof fakeBridge>, id: string) => {
  const found = bridge.lights.get(id);
  if (!found) throw new Error(`no light ${id}`);
  return found;
};

describe('store', () => {
  it('loads lights and groups when first subscribed', async () => {
    const { store } = setup();
    expect(store.getSnapshot().lights).toEqual([]);
    cleanups.push(store.subscribe(() => {}));
    await until(() => store.getSnapshot().lights.length === 3);
    expect(store.getSnapshot()).toMatchObject({ loading: false, error: null, v2Stale: false, groups: [{ id: '1' }] });
    expect(light(store, '1')?.v2Id).toBe('v2-1');
  });

  it('shows a command at once and resolves once the bridge applied it', async () => {
    const { store, bridge } = setup();
    await store.refresh();
    const done = store.setLight('1', { on: true, bri: 200 });
    expect(light(store, '1')).toMatchObject({ on: true, bri: 200 });
    expect(await done).toBe(true);
    expect(bridge.lights.get('1')?.state).toMatchObject({ on: true, bri: 200 });
  });

  it('rolls a refused command back', async () => {
    const { store, bridge, errors } = setup();
    await store.refresh();
    bridge.failWrites = 1;
    expect(await store.setLight('1', { bri: 10 })).toBe(false);
    expect(errors.map((e) => e.reason)).toEqual(['rejected']);
    await store.refresh();
    expect(light(store, '1')?.bri).toBe(100);
  });

  it('does not let a read that left before the command overwrite it', async () => {
    const { store } = setup({ latencyMs: 60 });
    await store.refresh();
    const read = store.refresh(); // will answer bri 100
    await new Promise((r) => setTimeout(r, 10));
    const write = store.setLight('1', { bri: 222 });
    await read;
    expect(light(store, '1')?.bri).toBe(222);
    await write;
  });

  it('coalesces rapid changes: few commands, and the last value lands', async () => {
    const { store, bridge } = setup({ latencyMs: 30 });
    await store.refresh();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.setLight('2', { bri: i + 1 })));
    expect(results.every(Boolean)).toBe(true);
    expect(bridge.writes().length).toBeLessThanOrEqual(3);
    expect(bridge.lights.get('2')?.state.bri).toBe(20);
  });

  it('keeps the latest colour when merging, whatever its kind', () => {
    expect(mergeState({ on: true, ct: 300 }, { xy: [0.5, 0.4] })).toEqual({ on: true, xy: [0.5, 0.4] });
    expect(mergeState({ hue: 1, sat: 2, bri: 9 }, { ct: 400 })).toEqual({ bri: 9, ct: 400 });
    expect(mergeState({ xy: [0.1, 0.1] }, { hue: 5 })).toEqual({ hue: 5 });
    expect(mergeState({ hue: 1, sat: 2 }, { sat: 3 })).toEqual({ hue: 1, sat: 3 });
  });

  it('turns colorloop off when a colour is set by hand', async () => {
    const { store, bridge } = setup();
    bulb(bridge, '1').state.effect = 'colorloop';
    await store.refresh();
    await store.setLight('1', { xy: [0.6, 0.3] });
    expect(bridge.writes()[0]?.body).toEqual({ xy: [0.6, 0.3], effect: 'none' });
  });

  it('stops an effect before commanding its light, but lets it adopt a brightness', async () => {
    const { store, bridge, effects, transport } = setup({ effects: true });
    await store.refresh();
    const loop: Effect = {
      name: 'loop',
      async run(ctx) {
        while (ctx.live()) await ctx.setLight('1', { on: true, bri: ctx.brightness() });
      },
    };
    await effects?.start(loop, {
      lights: store.getSnapshot().lights,
      transport,
      pace: { intervalMs: 5, maxInFlight: 1 },
    });
    expect(await store.setLight('1', { bri: 77 })).toBe(true);
    expect(effects?.getSnapshot().active?.name).toBe('loop');
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.writes().at(-1)?.body).toMatchObject({ bri: 77 }); // the effect's own frame, at the new brightness

    expect(await store.setLight('1', { xy: [0.2, 0.2] })).toBe(true);
    expect(effects?.getSnapshot().active).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.writes().at(-1)?.body).toEqual({ xy: [0.2, 0.2] });
  });

  it('turns everything off only after effects went silent, and confirms it', async () => {
    const { store, bridge, effects, transport } = setup({ effects: true, latencyMs: 20 });
    await store.refresh();
    const loop: Effect = {
      name: 'loop',
      async run(ctx) {
        while (ctx.live()) for (const l of ctx.lights) await ctx.setLight(l.id, { on: true });
      },
    };
    await effects?.start(loop, {
      lights: store.getSnapshot().lights,
      transport,
      pace: { intervalMs: 5, maxInFlight: 3 },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await store.allOff()).toBe(true);
    const offs = () => bridge.writes().filter((w) => w.path === '/api/local-key/groups/0/action');
    const firstOff = bridge.writes().indexOf(offs()[0] as never);
    expect(bridge.writes().slice(firstOff + 1)).toEqual([]); // nothing from the effect after the off
    expect([...bridge.lights.values()].every((l) => l.state.on === false)).toBe(true);
    await until(() => offs().length === 2, 3000); // the confirmation
  });

  it('drops a read older than one already applied', async () => {
    let calls = 0;
    const { store, bridge } = setup({
      transport: (t) => ({
        ...t,
        getLights: async () => {
          const lights = await t.getLights();
          if (++calls === 2) await new Promise((r) => setTimeout(r, 80)); // the older read answers last
          return lights;
        },
      }),
    });
    await store.refresh();
    const older = store.refresh();
    await new Promise((r) => setTimeout(r, 10));
    bulb(bridge, '1').state.bri = 7;
    await store.refresh();
    await older;
    expect(light(store, '1')?.bri).toBe(7);
  });

  it('keeps the last v2 data when a v2 read fails', async () => {
    let failV2 = false;
    const { store } = setup({
      transport: (t) => ({ ...t, getV2Lights: () => (failV2 ? Promise.reject(new Error('429')) : t.getV2Lights()) }),
    });
    await store.refresh();
    failV2 = true;
    await store.refresh();
    expect(store.getSnapshot().v2Stale).toBe(true);
    expect(light(store, '1')?.v2Id).toBe('v2-1');
  });

  it('reports a failed read and clears it on the next good one', async () => {
    const { store, bridge } = setup();
    bridge.hosts.clear();
    await store.refresh();
    expect(store.getSnapshot().error?.reason).toBe('unreachable');
    bridge.hosts.add(bridge.ip);
    await store.refresh();
    expect(store.getSnapshot().error).toBeNull();
  });

  it('resets on a transport switch and drops queued commands', async () => {
    const { store } = setup({ latencyMs: 40 });
    await store.refresh();
    const first = store.setLight('1', { bri: 1 });
    const queued = store.setLight('1', { bri: 2 });
    store.setTransport(null);
    expect(await queued).toBe(false);
    await first;
    expect(store.getSnapshot()).toMatchObject({ transport: null, lights: [], lastSync: 0 });
  });

  describe('command order', () => {
    it('drops queued room commands an allOff makes moot', async () => {
      const { store, bridge } = setup({ latencyMs: 20 });
      await store.refresh();
      const first = store.setGroup('1', { on: true, bri: 50 });
      const second = store.setGroup('1', { on: true, bri: 60 }); // waits for the 1 s group gap
      const off = store.allOff();
      expect(await Promise.all([first, second, off])).toEqual([true, true, true]);
      await sleep(1100);
      expect(bridge.writes().map((w) => [w.path, w.body])).toEqual([
        ['/api/local-key/groups/1/action', { on: true, bri: 50 }],
        ['/api/local-key/groups/0/action', { on: false }],
      ]);
      expect([...bridge.lights.values()].every((l) => l.state.on === false)).toBe(true);
    });

    it('does not let a later command overtake an allOff waiting for its barrier, nor its confirmation undo it', async () => {
      const { store, bridge, effects, transport } = setup({ effects: true, latencyMs: 20 });
      await store.refresh();
      await effects?.start(loop, {
        lights: store.getSnapshot().lights,
        transport,
        pace: { intervalMs: 5, maxInFlight: 3 },
      });
      await sleep(50);
      const off = store.allOff();
      const on = store.setLight('3', { on: true, bri: 33 }); // brightness-only: no barrier of its own
      expect(await Promise.all([off, on])).toEqual([true, true]);
      const paths = bridge.writes().map((w) => `${w.path} ${JSON.stringify(w.body)}`);
      expect(paths.indexOf('/api/local-key/groups/0/action {"on":false}')).toBeLessThan(
        paths.indexOf('/api/local-key/lights/3/state {"on":true,"bri":33}'),
      );
      await sleep(2300); // past the confirmation delay
      expect(bulb(bridge, '3').state).toMatchObject({ on: true, bri: 33 });
    });

    it('lets a scene make queued colours moot', async () => {
      const { store, bridge } = setup({ latencyMs: 20 });
      await store.refresh();
      const results = Promise.all([
        store.setGroup('1', { xy: [0.6, 0.3] }),
        store.setGroup('1', { xy: [0.2, 0.2] }),
        store.recallScene('1', 'abc'),
      ]);
      expect(await results).toEqual([true, true, true]);
      expect(bridge.writes().map((w) => w.body)).toEqual([{ xy: [0.6, 0.3] }, { scene: 'abc' }]);
    });

    it('keeps at most three commands in flight, never two on one light', async () => {
      const { store, bridge } = setup({ latencyMs: 40 });
      await store.refresh();
      bridge.maxInFlight = 0;
      await Promise.all([
        ...['1', '2', '3'].map((id) => store.setLight(id, { on: true })),
        store.setGroup('1', { bri: 9 }),
        store.setLight('1', { bri: 10 }),
      ]);
      expect(bridge.maxInFlight).toBeLessThanOrEqual(3);
      const order = bridge.writes().map((w) => w.path);
      expect(order.indexOf('/api/local-key/groups/1/action')).toBeLessThan(
        order.lastIndexOf('/api/local-key/lights/1/state'),
      );
      expect(bulb(bridge, '1').state.bri).toBe(10);
    });

    it('does not black out an effect started after an allOff', async () => {
      const { store, bridge, effects, transport } = setup({ effects: true, latencyMs: 10 });
      await store.refresh();
      const once: Effect = {
        name: 'once',
        async run(ctx) {
          for (const l of ctx.lights) await ctx.setLight(l.id, { on: true, bri: 77 });
          while (ctx.live()) await ctx.sleep(1000);
        },
      };
      await effects?.start(loop, {
        lights: store.getSnapshot().lights,
        transport,
        pace: { intervalMs: 5, maxInFlight: 3 },
      });
      await sleep(30);
      await store.allOff();
      await sleep(300);
      await effects?.start(once, {
        lights: store.getSnapshot().lights,
        transport,
        pace: { intervalMs: 5, maxInFlight: 3 },
      });
      await sleep(2300);
      expect([...bridge.lights.values()].every((l) => l.state.on === true)).toBe(true);
    });
  });

  describe('rollback', () => {
    it('restores the snapshot as soon as a command fails, even with the bridge gone', async () => {
      const { store, bridge } = setup();
      await store.refresh();
      bridge.hosts.clear();
      expect(await store.setLight('1', { on: true })).toBe(false);
      expect(light(store, '1')?.on).toBe(false);
    });

    it('keeps a newer command shown when an older one fails', async () => {
      const { store, bridge } = setup({ latencyMs: 30 });
      await store.refresh();
      bridge.failWrites = 1;
      const older = store.setLight('1', { bri: 10 });
      await sleep(5);
      const newer = store.setLight('1', { bri: 20 }); // queued behind the one in flight
      expect(await older).toBe(false);
      expect(light(store, '1')?.bri).toBe(20);
      expect(await newer).toBe(true);
      expect(bulb(bridge, '1').state.bri).toBe(20);
    });
  });

  it('clears colorloop when a room gets a colour', async () => {
    const { store, bridge } = setup();
    bulb(bridge, '1').state.effect = 'colorloop';
    await store.refresh();
    await store.setGroup('1', { xy: [0.6, 0.3] });
    expect(bridge.writes()[0]?.body).toEqual({ xy: [0.6, 0.3], effect: 'none' });
  });

  it('applies the groups of a refresh overtaken by a background read', async () => {
    let slowNext = false;
    let extraGroup = false;
    const { store } = setup({
      pollMs: 50,
      transport: (t) => ({
        ...t,
        getLights: async () => {
          const slow = slowNext;
          slowNext = false;
          const lights = await t.getLights();
          if (slow) await sleep(300);
          return lights;
        },
        getGroups: async () => [
          ...(await t.getGroups()),
          ...(extraGroup ? [{ id: '9', name: 'Kitchen', type: 'Room' as const, lightIds: ['3'] }] : []),
        ],
      }),
    });
    cleanups.push(store.subscribe(() => {}));
    await until(() => store.getSnapshot().lights.length === 3);
    slowNext = true;
    extraGroup = true;
    await store.refresh(); // background reads land while it waits
    expect(store.getSnapshot().groups.map((g) => g.id)).toEqual(['1', '9']);
  });

  it('keeps sending when the system clock jumps back', async () => {
    const { store, bridge } = setup();
    await store.refresh();
    await store.setLight('1', { bri: 10 });
    const back = Date.now() - 3_600_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(back);
    try {
      expect(await store.setLight('1', { bri: 20 })).toBe(true);
      expect(bulb(bridge, '1').state.bri).toBe(20);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops all work on destroy, including what commands in flight would trigger', async () => {
    const { store, bridge } = setup({ latencyMs: 50 });
    await store.refresh();
    const pending = store.setLight('1', { bri: 10 });
    await sleep(5);
    store.destroy();
    await pending;
    const seen = bridge.log.length;
    await sleep(900);
    expect(bridge.log.length).toBe(seen);
    expect(await store.setLight('1', { bri: 11 })).toBe(false);
  });

  it('shows a refusal by the relay at once, even from a background read', async () => {
    let refuse = false;
    const { store } = setup({
      pollMs: 30,
      transport: (t) => ({
        ...t,
        getLights: () =>
          refuse ? Promise.reject(new HueError('forbidden', 'Not allowed to use this relay.')) : t.getLights(),
      }),
    });
    cleanups.push(store.subscribe(() => {}));
    await until(() => store.getSnapshot().lights.length === 3);
    refuse = true;
    await until(() => store.getSnapshot().error !== null);
    expect(store.getSnapshot().error?.reason).toBe('forbidden');
  });
});

describe('store, under pressure', () => {
  it('clears a native effect once, not once per colour event of a drag', async () => {
    const { store, bridge } = setup({ latencyMs: 30 });
    bulb(bridge, '1').effect = 'candle';
    await store.refresh();
    const drag = Array.from({ length: 30 }, (_, i) => [0.1 + i / 100, 0.3] as const);
    const results: Promise<boolean>[] = [];
    for (const xy of drag) {
      results.push(store.setLight('1', { xy }));
      await sleep(10);
    }
    const doneAt = Date.now();
    expect((await Promise.all(results)).every(Boolean)).toBe(true);
    expect(Date.now() - doneAt).toBeLessThan(1000);
    expect(bridge.writes().filter((w) => w.path.startsWith('/clip/')).length).toBe(1);
    expect(bulb(bridge, '1').state.xy).toEqual(drag.at(-1));
  });

  it('keeps working when onCommandError or a listener throws', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (e: unknown) => reported.push(e));
    try {
      const bridge = fakeBridge({ latencyMs: 5 });
      const store = createHueStore({
        transport: createLocalTransport({ host: bridge.ip, appKey: 'local-key', fetch: bridge.fetch }),
        pollMs: { local: 60_000 },
        onCommandError: () => {
          throw new Error('toast not mounted');
        },
      });
      cleanups.push(() => store.destroy());
      await store.refresh();
      cleanups.push(
        store.subscribe(() => {
          throw new Error('render bug');
        }),
      );
      bridge.failWrites = 1;
      expect(await store.setLight('1', { bri: 10 })).toBe(false);
      expect(await store.setLight('1', { bri: 20 })).toBe(true);
      expect(bulb(bridge, '1').state.bri).toBe(20);
      expect(reported.map(String)).toContain('Error: toast not mounted');
      expect(reported.map(String)).toContain('Error: render bug');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never sends the "off" confirmation to a transport switched in meanwhile', async () => {
    const { store, bridge, effects, transport } = setup({ effects: true, latencyMs: 10 });
    const other = fakeBridge({ latencyMs: 5 });
    for (const l of other.lights.values()) l.state.on = true;
    await store.refresh();
    await effects?.start(loop, {
      lights: store.getSnapshot().lights,
      transport,
      pace: { intervalMs: 5, maxInFlight: 3 },
    });
    await sleep(30);
    bridge.latencyMs = 200;
    const off = store.allOff();
    await until(() => bridge.writes().some((w) => w.path === '/api/local-key/groups/0/action'));
    store.setTransport(createLocalTransport({ host: other.ip, appKey: 'local-key', fetch: other.fetch }));
    await off;
    await sleep(2300);
    expect(other.writes()).toEqual([]);
  });

  it('still stops effects when an "off" is overtaken by an "on"', async () => {
    const { store, effects, transport } = setup({ effects: true });
    await store.refresh();
    await effects?.start(loop, {
      lights: store.getSnapshot().lights,
      transport,
      pace: { intervalMs: 5, maxInFlight: 3 },
    });
    await store.setGroup('0', { bri: 120 }); // the next group command waits a second
    const results = await Promise.all([store.allOff(), store.setGroup('0', { on: true })]);
    expect(results).toEqual([true, true]);
    expect(effects?.getSnapshot().active).toBeNull();
  });

  it('lets an effect started after a queued "off" win over it', async () => {
    const { store, bridge, effects, transport } = setup({ effects: true });
    await store.refresh();
    await store.setGroup('0', { bri: 120 });
    const off = store.allOff(); // queued behind the group spacing
    await sleep(100);
    const hold: Effect = {
      name: 'hold',
      async run(ctx) {
        for (const l of ctx.lights) await ctx.setLight(l.id, { on: true, bri: 77 });
        while (ctx.live()) await ctx.sleep(1000);
      },
    };
    await effects?.start(hold, {
      lights: store.getSnapshot().lights,
      transport,
      pace: { intervalMs: 5, maxInFlight: 3 },
    });
    expect(await off).toBe(true);
    await sleep(1300);
    expect(effects?.getSnapshot().active?.name).toBe('hold');
    expect([...bridge.lights.values()].every((l) => l.state.on === true)).toBe(true);
  });

  it('orders the "off" confirmation like any command: a newer "on" lands after it', async () => {
    let offs = 0;
    let groupInFlight = 0;
    let maxGroupInFlight = 0;
    const { store, bridge, effects, transport } = setup({
      effects: true,
      transport: (t) => ({
        ...t,
        setGroup: async (id, state, o) => {
          groupInFlight += 1;
          maxGroupInFlight = Math.max(maxGroupInFlight, groupInFlight);
          try {
            if (state.on === false && ++offs === 2) await sleep(400); // the confirmation is slow
            await t.setGroup(id, state, o);
          } finally {
            groupInFlight -= 1;
          }
        },
      }),
    });
    await store.refresh();
    await effects?.start(loop, {
      lights: store.getSnapshot().lights,
      transport,
      pace: { intervalMs: 5, maxInFlight: 3 },
    });
    await sleep(30);
    await store.allOff();
    await sleep(2050); // the confirmation is on the wire
    expect(await store.setGroup('0', { on: true })).toBe(true);
    await sleep(600);
    expect([...bridge.lights.values()].every((l) => l.state.on === true)).toBe(true);
    expect(maxGroupInFlight).toBe(1);
  });

  it('keeps the mask of a slow command when an opaque one before it settles', async () => {
    const { store } = setup({
      transport: (t) => ({
        ...t,
        setLight: async (id, state, o) => {
          await sleep(2500);
          await t.setLight(id, state, o);
        },
      }),
    });
    await store.refresh();
    void store.writeV2('1', { effects: { effect: 'candle' } });
    const slow = store.setLight('1', { bri: 222 });
    await sleep(2100); // the re-read after the v2 write has landed
    expect(light(store, '1')?.bri).toBe(222);
    await slow;
  });

  it('rolls back to what the bridge last accepted, not to the value before it', async () => {
    const { store } = setup({
      transport: (t) => ({ ...t, setGroup: () => Promise.reject(new HueError('rejected', 'nope')) }),
    });
    await store.refresh();
    expect(await store.setLight('1', { bri: 10 })).toBe(true);
    expect(await store.setGroup('1', { bri: 20 })).toBe(false);
    expect(light(store, '1')?.bri).toBe(10);
  });
});

describe('store across tabs', () => {
  it('does not black out an effect another tab starts after an allOff', async () => {
    const channel = `store-tabs-${Math.random()}`;
    const bridge = fakeBridge({ latencyMs: 10 });
    const transport = createLocalTransport({ host: bridge.ip, appKey: 'local-key', fetch: bridge.fetch });
    const tab1 = createEffectManager({ channel });
    const tab2 = createEffectManager({ channel });
    const store = createHueStore({ transport, effects: tab1, pollMs: { local: 60_000 } });
    cleanups.push(
      () => store.destroy(),
      () => tab1.destroy(),
      () => tab2.destroy(),
    );
    await store.refresh();
    const pace = { intervalMs: 5, maxInFlight: 3 };
    await tab2.start(loop, { lights: store.getSnapshot().lights, transport, pace });
    await until(() => tab1.getSnapshot().elsewhere.length === 1);
    expect(await store.allOff()).toBe(true);
    expect(tab2.getSnapshot().active).toBeNull();
    await sleep(300);
    const hold: Effect = {
      name: 'hold',
      async run(ctx) {
        for (const l of ctx.lights) await ctx.setLight(l.id, { on: true, bri: 77 });
        while (ctx.live()) await ctx.sleep(1000);
      },
    };
    await tab2.start(hold, { lights: store.getSnapshot().lights, transport, pace });
    await sleep(2300); // past the confirmation
    expect([...bridge.lights.values()].every((l) => l.state.on === true)).toBe(true);
  });
});
