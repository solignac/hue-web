import { describe, expect, it } from 'vitest';
import {
  checkKey,
  createCloudTransport,
  createRelayClient,
  findBridge,
  memoryTokenStore,
  type ProbeOptions,
  pairBridge,
  probeBridge,
  requestKey,
} from '../src/index.js';
import { createRelayHandler } from '../src/relay.js';
import { fakeBridge, fakeRemote } from './fake-bridge.js';

const page: typeof fetch = async () =>
  new Response('<!doctype html><title>Router</title>', { status: 200, headers: { 'content-type': 'text/html' } });

/** `bridge.fetch`, except that `POST /api` gets `answer`. */
const keyAnswer =
  (bridge: ReturnType<typeof fakeBridge>, answer: () => Response): typeof fetch =>
  (input, init) =>
    new URL(String(input)).pathname === '/api' && init?.method === 'POST'
      ? Promise.resolve(answer())
      : bridge.fetch(input, init);

async function cloudFor(bridge: ReturnType<typeof fakeBridge>) {
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

describe('discovery', () => {
  it('probes a bridge without a key', async () => {
    const bridge = fakeBridge();
    expect(await probeBridge(bridge.ip, { fetch: bridge.fetch })).toEqual({ id: 'ecb5fafffe0a1b2c' });
    expect(await probeBridge('10.9.9.9', { fetch: bridge.fetch })).toBeNull();
  });

  it('counts a host as a bridge only if it says which bridge it is', async () => {
    const device: ProbeOptions = { fetch: async () => Response.json({ name: 'Some device' }) };
    expect(await probeBridge('192.168.1.1', device)).toBeNull();
    expect(await probeBridge('192.168.1.1', { fetch: page })).toBeNull();
  });

  it('does not take a web page answering 200 for a key that works', async () => {
    expect(await checkKey('192.168.1.1', 'local-key', { fetch: page })).toBe('unreachable');
  });

  it('checks keys', async () => {
    const bridge = fakeBridge();
    expect(await checkKey(bridge.ip, 'local-key', { fetch: bridge.fetch })).toBe('ok');
    expect(await checkKey(bridge.ip, 'stale', { fetch: bridge.fetch })).toBe('refused');
    expect(await checkKey('10.9.9.9', 'local-key', { fetch: bridge.fetch })).toBe('unreachable');
  });

  it('requests a key only after the link button', async () => {
    const bridge = fakeBridge();
    await expect(requestKey(bridge.ip, { fetch: bridge.fetch })).rejects.toMatchObject({
      reason: 'link-button',
      code: 101,
    });
    bridge.pressButton();
    expect(await requestKey(bridge.ip, { fetch: bridge.fetch, deviceType: 'app#test' })).toBe('new-key-1');
    expect(bridge.log.at(-1)?.body).toEqual({ devicetype: 'app#test' });
  });

  it('finds the bridge at the address the cloud reports, before mDNS', async () => {
    const bridge = fakeBridge({ hosts: ['192.168.1.20', 'philips-hue.local'] });
    const found = await findBridge({ cloud: await cloudFor(bridge), fetch: bridge.fetch });
    expect(found).toEqual({ host: '192.168.1.20', id: 'ecb5fafffe0a1b2c', cloudIp: '192.168.1.20' });
  });

  it('falls back on mDNS without a cloud, and on hints', async () => {
    const mdnsOnly = fakeBridge({ hosts: ['philips-hue.local'] });
    expect((await findBridge({ fetch: mdnsOnly.fetch })).host).toBe('philips-hue.local');
    const hinted = fakeBridge({ hosts: ['10.0.0.5'] });
    expect((await findBridge({ hints: ['10.0.0.5'], fetch: hinted.fetch })).host).toBe('10.0.0.5');
  });

  it('never returns a bridge other than the cloud one', async () => {
    const home = fakeBridge({ id: 'AAAA', hosts: [] });
    const neighbour = fakeBridge({ id: 'BBBB', hosts: ['philips-hue.local'] });
    const found = await findBridge({ cloud: await cloudFor(home), fetch: neighbour.fetch });
    expect(found).toEqual({ host: null, id: 'aaaa', cloudIp: '192.168.1.20' });
  });

  it('once the cloud id is known, skips a host that cannot say which bridge it is', async () => {
    const home = fakeBridge({ id: 'AAAA', hosts: [] });
    const anonymous: typeof fetch = (input, init) =>
      new URL(String(input)).hostname === 'philips-hue.local'
        ? Promise.resolve(Response.json({ name: 'Hue Bridge' }))
        : home.fetch(input, init);
    const found = await findBridge({ cloud: await cloudFor(home), fetch: anonymous });
    expect(found).toEqual({ host: null, id: 'aaaa', cloudIp: '192.168.1.20' });
  });

  it('reads a key request answered by a server error or a web page as the bridge being unavailable', async () => {
    const bridge = fakeBridge();
    const busy = keyAnswer(bridge, () => new Response('oops', { status: 503 }));
    await expect(requestKey(bridge.ip, { fetch: busy })).rejects.toMatchObject({ reason: 'unavailable', status: 503 });
    await expect(requestKey(bridge.ip, { fetch: page })).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('waits for a slow cloud to say which bridge is ours, rather than take any that answers', async () => {
    const home = fakeBridge({ id: 'AAAA', hosts: [] });
    const housemate = fakeBridge({ id: 'BBBB', hosts: ['philips-hue.local'] });
    const cloud = await cloudFor(home);
    const slow = {
      ...cloud,
      getBridgeInfo: () =>
        new Promise<Awaited<ReturnType<typeof cloud.getBridgeInfo>>>((r) =>
          setTimeout(() => r(cloud.getBridgeInfo()), 3000),
        ),
    };
    expect(await findBridge({ cloud: slow, fetch: housemate.fetch })).toEqual({
      host: null,
      id: 'aaaa',
      cloudIp: '192.168.1.20',
    });
  });
});

describe('pairing', () => {
  it('reuses a known key that still works', async () => {
    const bridge = fakeBridge();
    const result = await pairBridge({ knownKeys: [null, 'stale', 'local-key'], fetch: bridge.fetch });
    expect(result).toEqual({ status: 'paired', host: 'philips-hue.local', appKey: 'local-key', via: 'known-key' });
  });

  it("tries the cloud's own key locally", async () => {
    const bridge = fakeBridge({ keys: [] });
    const cloud = await cloudFor(bridge);
    const result = await pairBridge({ cloud, fetch: bridge.fetch });
    expect(result).toEqual({ status: 'paired', host: '192.168.1.20', appKey: 'new-key-1', via: 'cloud-key' });
  });

  it('presses the link button through the cloud when no key works', async () => {
    const bridge = fakeBridge({ keys: [] });
    const cloud = await cloudFor(bridge);
    bridge.keys.clear(); // the cloud key is not accepted locally
    const remoteKeyRequests = (): number => bridge.log.filter((l) => l.path === '/api' && l.host !== 'remote').length;
    const result = await pairBridge({ cloud, fetch: bridge.fetch });
    expect(result).toMatchObject({ status: 'paired', via: 'remote-button' });
    expect(remoteKeyRequests()).toBe(1);
  });

  it('waits for a physical press, and says when to press', async () => {
    const bridge = fakeBridge();
    let asked = 0;
    const result = await pairBridge({
      fetch: bridge.fetch,
      onLinkButton: () => {
        asked += 1;
        setTimeout(() => bridge.pressButton(), 300);
      },
    });
    expect(asked).toBe(1);
    expect(result).toMatchObject({ status: 'paired', via: 'link-button', appKey: 'new-key-1' });
  });

  it('gives up after the button timeout', async () => {
    const bridge = fakeBridge();
    expect(await pairBridge({ host: bridge.ip, fetch: bridge.fetch, buttonTimeoutMs: 50 })).toEqual({
      status: 'timeout',
      host: bridge.ip,
    });
  });

  it('says which address to authorise when nothing answers', async () => {
    const home = fakeBridge({ hosts: [] });
    const result = await pairBridge({ cloud: await cloudFor(home), fetch: home.fetch });
    expect(result).toEqual({ status: 'unreachable', candidate: '192.168.1.20' });
  });

  it('reports a key request the bridge refuses, instead of calling the bridge unreachable', async () => {
    const bridge = fakeBridge();
    const refusing = keyAnswer(bridge, () =>
      Response.json([
        { error: { type: 7, address: '/devicetype', description: 'invalid value for parameter, devicetype' } },
      ]),
    );
    const started = Date.now();
    await expect(pairBridge({ host: bridge.ip, fetch: refusing, buttonTimeoutMs: 10_000 })).rejects.toMatchObject({
      name: 'HueError',
      reason: 'rejected',
      code: 7,
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still tolerates a few missed answers while waiting for the button', async () => {
    const bridge = fakeBridge();
    let calls = 0;
    const hiccup: typeof fetch = (input, init) => {
      if (new URL(String(input)).pathname === '/api' && ++calls <= 2)
        return Promise.reject(new TypeError('fetch failed'));
      return bridge.fetch(input, init);
    };
    setTimeout(() => bridge.pressButton(), 2500);
    expect(await pairBridge({ host: bridge.ip, fetch: hiccup })).toMatchObject({
      status: 'paired',
      via: 'link-button',
    });
  });

  it('refuses a device type the bridge would not accept, before sending anything', async () => {
    const bridge = fakeBridge();
    bridge.pressButton();
    for (const deviceType of ['no-hash', `${'a'.repeat(21)}#dev`, `app#${'d'.repeat(20)}`, 'a#b#c', '#dev', 'app#']) {
      await expect(requestKey(bridge.ip, { fetch: bridge.fetch, deviceType }), deviceType).rejects.toThrow(TypeError);
      await expect(pairBridge({ host: bridge.ip, fetch: bridge.fetch, deviceType }), deviceType).rejects.toThrow(
        TypeError,
      );
    }
    expect(bridge.log).toEqual([]);
    const longest = `${'a'.repeat(20)}#${'d'.repeat(19)}`;
    expect(await requestKey(bridge.ip, { fetch: bridge.fetch, deviceType: longest })).toBe('new-key-1');
  });

  it('can be aborted while waiting for the button, and says so', async () => {
    const bridge = fakeBridge();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(pairBridge({ host: bridge.ip, fetch: bridge.fetch, signal: controller.signal })).rejects.toMatchObject(
      { name: 'HueError', reason: 'aborted', message: 'Pairing was cancelled.' },
    );
  });

  it('keeps waiting for the button through a bridge briefly answering 503', async () => {
    const bridge = fakeBridge();
    let calls = 0;
    const flaky: typeof fetch = (input, init) =>
      new URL(String(input)).pathname === '/api' && init?.method === 'POST' && ++calls <= 2
        ? Promise.resolve(new Response('busy', { status: 503 }))
        : bridge.fetch(input, init);
    setTimeout(() => bridge.pressButton(), 2500);
    expect(await pairBridge({ host: bridge.ip, fetch: flaky })).toMatchObject({ status: 'paired', via: 'link-button' });
  });
});
