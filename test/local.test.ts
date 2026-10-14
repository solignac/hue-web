import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridgeUrl, createLocalTransport, type HueError, isHueError } from '../src/index.js';
import { fakeBridge } from './fake-bridge.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local transport', () => {
  it('reaches bare hosts over HTTPS and keeps an explicit scheme', () => {
    expect(bridgeUrl('192.168.1.20')).toBe('https://192.168.1.20');
    expect(bridgeUrl(' http://hue.lan/ ')).toBe('http://hue.lan');
  });

  it('reads lights, groups, scenes and bridge info', async () => {
    const bridge = fakeBridge();
    const t = createLocalTransport({ host: bridge.ip, appKey: 'local-key', fetch: bridge.fetch });
    expect((await t.getLights()).map((l) => l.name)).toEqual(['Lamp', 'Bulb', 'White']);
    expect(await t.getGroups()).toEqual([
      { id: '1', name: 'Living room', type: 'Room', class: 'Living room', lightIds: ['1', '2', '3'] },
    ]);
    expect(await t.getScenes()).toEqual([{ id: 'abc', name: 'Relax', groupId: '1' }]);
    expect(await t.getBridgeInfo()).toEqual({ id: 'ecb5fafffe0a1b2c', ip: '192.168.1.20' });
  });

  it('sends v1 bodies without any header, so nothing has to pass CORS', async () => {
    const bridge = fakeBridge();
    const t = createLocalTransport({ host: bridge.ip, appKey: 'local-key', fetch: bridge.fetch });
    await t.setLight('1', { on: true, bri: 42 });
    const write = bridge.writes()[0];
    expect(write).toMatchObject({ method: 'PUT', path: '/api/local-key/lights/1/state', body: { on: true, bri: 42 } });
    expect([...(write?.headers.keys() ?? [])]).toEqual([]);
  });

  it('accepts partial success: a white light ignoring a colour is not an error', async () => {
    const bridge = fakeBridge();
    const t = createLocalTransport({ host: bridge.ip, appKey: 'local-key', fetch: bridge.fetch });
    await expect(t.setLight('3', { on: true, xy: [0.6, 0.3] })).resolves.toBeUndefined();
    expect(bridge.lights.get('3')?.state.on).toBe(true);
  });

  it('maps a refused key to reason "unauthorized"', async () => {
    const bridge = fakeBridge();
    const t = createLocalTransport({ host: bridge.ip, appKey: 'nope', fetch: bridge.fetch });
    await expect(t.getLights()).rejects.toMatchObject({ name: 'HueError', reason: 'unauthorized', code: 1 });
  });

  it('explains an unreachable bridge with the certificate step in a browser', async () => {
    vi.stubGlobal('document', {});
    const t = createLocalTransport({ host: '10.0.0.9', appKey: 'k', fetch: fakeBridge().fetch });
    const error = await t.getLights().catch((e: unknown) => e);
    expect(isHueError(error, 'unreachable')).toBe(true);
    expect((error as HueError).message).toContain('Open https://10.0.0.9 in a tab and accept its certificate');
  });

  it('gives up on CLIP v2 from a page once, without retrying on every read', async () => {
    vi.stubGlobal('document', {});
    const bridge = fakeBridge({ browser: true });
    let attempts = 0;
    const counting: typeof fetch = (input, init) => {
      if (String(input).includes('/clip/')) attempts += 1;
      return bridge.fetch(input, init);
    };
    const t = createLocalTransport({ host: bridge.ip, appKey: 'local-key', fetch: counting });
    expect(await t.getV2Lights()).toEqual([]);
    expect(await t.getV2Lights()).toEqual([]);
    await expect(t.writeV2('v2-1', { on: { on: true } })).rejects.toMatchObject({ reason: 'unsupported' });
    expect(attempts).toBe(1);
  });

  it('serves CLIP v2 outside a browser', async () => {
    const bridge = fakeBridge();
    const t = createLocalTransport({ host: bridge.ip, appKey: 'local-key', fetch: bridge.fetch });
    expect((await t.getV2Lights()).length).toBe(3);
    await t.writeV2('v2-1', { effects: { effect: 'candle' } });
    expect(bridge.lights.get('1')?.effect).toBe('candle');
  });

  it('sends nothing once the signal is aborted', async () => {
    const bridge = fakeBridge();
    const t = createLocalTransport({ host: bridge.ip, appKey: 'local-key', fetch: bridge.fetch });
    const controller = new AbortController();
    controller.abort();
    await expect(t.setLight('1', { on: true }, { signal: controller.signal })).rejects.toMatchObject({
      reason: 'aborted',
    });
    expect(bridge.log).toEqual([]);
  });

  it('does not take a web page answering 200 for a bridge', async () => {
    const page: typeof fetch = async () =>
      new Response('<!doctype html><title>Router</title>', { status: 200, headers: { 'content-type': 'text/html' } });
    const t = createLocalTransport({ host: '192.168.1.1', appKey: 'k', fetch: page });
    const error = await t.getLights().catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'HueError', reason: 'unavailable', status: 200 });
    expect((error as HueError).message).toContain('https://192.168.1.1 does not look like a Hue bridge');
    await expect(t.setLight('1', { on: true })).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('times out a hung request', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    const t = createLocalTransport({ host: 'x', appKey: 'k', fetch: hang, timeoutMs: 20 });
    await expect(t.getLights()).rejects.toMatchObject({ reason: 'unreachable' });
  });
});
