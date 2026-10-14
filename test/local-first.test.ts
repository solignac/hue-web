import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CloudTransport,
  createCloudTransport,
  createLocalTransport,
  createRelayClient,
  HueError,
  type HueTransport,
  type LocalBridge,
  localFirst,
  memoryTokenStore,
} from '../src/index.js';
import { createRelayHandler } from '../src/relay.js';
import { type FakeBridge, fakeBridge, fakeRemote } from './fake-bridge.js';

afterEach(() => {
  vi.useRealTimers();
});

/** A cloud transport reaching `bridge` through a relay and the fake remote API. */
async function cloudFor(bridge: FakeBridge): Promise<CloudTransport> {
  const remote = fakeRemote(bridge);
  const handler = createRelayHandler({
    clientId: 'client',
    clientSecret: 'secret',
    authorize: () => true,
    fetch: remote.fetch,
  });
  const relay = createRelayClient({
    url: 'https://relay.example',
    fetch: (input, init) => handler(new Request(String(input), init)),
  });
  return createCloudTransport({ relay, tokens: memoryTokenStore(await relay.exchange('good-code')) });
}

/** A LAN `fetch` that records the host of every request, answered or not. */
function lan(fetchFn: typeof fetch): { fetch: typeof fetch; hosts: string[] } {
  const hosts: string[] = [];
  return {
    hosts,
    fetch: (input, init) => {
      hosts.push(new URL(String(input)).hostname);
      return fetchFn(input, init);
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `cloud`, with another way of reading the bridge's identity. */
const withIdentity = (cloud: CloudTransport, getBridgeInfo: CloudTransport['getBridgeInfo']): CloudTransport => ({
  ...cloud,
  getBridgeInfo,
});

const paired: LocalBridge = { host: '192.168.1.20', appKey: 'local-key' };

describe('localFirst', () => {
  it('picks the local bridge when it is the cloud one', async () => {
    const bridge = fakeBridge();
    const pick = localFirst({ fallback: await cloudFor(bridge), local: paired, fetch: bridge.fetch });
    const picked = await pick();
    expect(picked.kind).toBe('local');
    expect(picked.label).toBe('192.168.1.20');
  });

  it('falls back when the local bridge is another one', async () => {
    const home = fakeBridge({ id: 'AAAA', hosts: [] });
    const neighbour = fakeBridge({ id: 'BBBB' });
    const cloud = await cloudFor(home);
    expect(await localFirst({ fallback: cloud, local: paired, fetch: neighbour.fetch })()).toBe(cloud);
  });

  it('reads the cloud identity as soon as it is created, and once', async () => {
    const bridge = fakeBridge();
    const cloud = await cloudFor(bridge);
    let reads = 0;
    const counted = withIdentity(cloud, () => {
      reads += 1;
      return cloud.getBridgeInfo();
    });
    const pick = localFirst({ fallback: counted, local: paired, fetch: bridge.fetch });
    expect(reads).toBe(1);
    expect((await pick()).kind).toBe('local');
    expect(reads).toBe(1);
  });

  it('waits for a slow first identity read rather than trusting whatever answers', async () => {
    const home = fakeBridge({ id: 'AAAA', hosts: [] });
    const neighbour = fakeBridge({ id: 'BBBB' });
    const cloud = await cloudFor(home);
    const slow = withIdentity(cloud, () => sleep(2000).then(() => cloud.getBridgeInfo()));
    expect(await localFirst({ fallback: slow, local: paired, fetch: neighbour.fetch })()).toBe(slow);
  });

  it('accepts an unverified bridge only once the cloud read failed', async () => {
    const bridge = fakeBridge();
    const net = lan(bridge.fetch);
    const cloud = await cloudFor(bridge);
    const down = withIdentity(cloud, () =>
      Promise.reject(new HueError('unreachable', 'Could not reach the Hue relay.')),
    );
    const pick = localFirst({ fallback: down, local: paired, fetch: net.fetch });
    expect((await pick()).kind).toBe('local');
    const probes = net.hosts.length;
    expect((await pick()).kind).toBe('local');
    expect(net.hosts.length).toBeGreaterThan(probes); // unverified: never cached
  });

  it('accepts an unverified bridge once the first identity read is 8 s late, not before', async () => {
    const bridge = fakeBridge();
    const cloud = await cloudFor(bridge);
    vi.useFakeTimers();
    const hung = withIdentity(cloud, () => new Promise(() => {}));
    let picked: HueTransport | undefined;
    void localFirst({ fallback: hung, local: paired, fetch: bridge.fetch })().then((t) => {
      picked = t;
    });
    await vi.advanceTimersByTimeAsync(7900);
    expect(picked).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(picked?.kind).toBe('local');
  });

  it('falls back when the local bridge does not answer', async () => {
    const bridge = fakeBridge({ hosts: [] });
    const cloud = await cloudFor(bridge);
    expect(await localFirst({ fallback: cloud, local: paired, fetch: bridge.fetch })()).toBe(cloud);
  });

  it('does not take a host answering 200 for a bridge', async () => {
    const bridge = fakeBridge();
    const cloud = await cloudFor(bridge);
    const anything: typeof fetch = async () => Response.json({});
    expect(await localFirst({ fallback: cloud, local: paired, fetch: anything })()).toBe(cloud);
    const down = withIdentity(cloud, () =>
      Promise.reject(new HueError('unreachable', 'Could not reach the Hue relay.')),
    );
    expect(await localFirst({ fallback: down, local: paired, fetch: anything })()).toBe(down);
  });

  it('follows the bridge to the address the cloud reports, and remembers it under the saved one', async () => {
    const bridge = fakeBridge({ ip: '192.168.1.30' }); // a new DHCP lease: nothing answers at .20 any more
    const net = lan(bridge.fetch);
    const moved: LocalBridge[] = [];
    const pick = localFirst({
      fallback: await cloudFor(bridge),
      local: paired, // a static option: it keeps the old address
      fetch: net.fetch,
      onMoved: (b) => moved.push(b),
    });
    const first = await pick();
    expect(first.kind).toBe('local');
    expect(first.label).toBe('192.168.1.30');
    expect(moved).toEqual([{ host: '192.168.1.30', appKey: 'local-key' }]);
    const probes = net.hosts.length;
    expect(await pick()).toBe(first);
    expect(net.hosts.length).toBe(probes); // the dead address is not probed again
    expect(moved).toHaveLength(1);
  });

  it('returns a local fallback as is', async () => {
    const bridge = fakeBridge();
    const net = lan(bridge.fetch);
    const local = createLocalTransport({ ...paired, fetch: bridge.fetch });
    expect(await localFirst({ fallback: local, local: paired, fetch: net.fetch })()).toBe(local);
    expect(net.hosts).toEqual([]);
  });

  it('reuses a verified pick for 30 s without probing again', async () => {
    const bridge = fakeBridge();
    const net = lan(bridge.fetch);
    const pick = localFirst({ fallback: await cloudFor(bridge), local: paired, fetch: net.fetch });
    const first = await pick();
    const probes = net.hosts.length;
    expect(probes).toBeGreaterThan(0);
    expect(await pick()).toBe(first);
    expect(net.hosts.length).toBe(probes);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    expect(await pick()).not.toBe(first);
    expect(net.hosts.length).toBeGreaterThan(probes);
  });
});
