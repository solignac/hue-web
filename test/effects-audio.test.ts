import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioSync, createLocalTransport, readLights, runEffect } from '../src/index.js';
import { fakeBridge } from './fake-bridge.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('audioSync', () => {
  it('releases the microphone when the audio context cannot be created', async () => {
    const bridge = fakeBridge();
    const transport = createLocalTransport({ host: bridge.ip, appKey: 'local-key', fetch: bridge.fetch });
    const { lights } = await readLights(transport);
    let stopped = 0;
    const stream = { getTracks: () => [{ stop: () => (stopped += 1) }] };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream } });
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('AudioContext is not available');
        }
      },
    );
    const end = await runEffect(audioSync(), { transport, lights }).done;
    expect(end.reason).toBe('failed');
    expect(end.error?.message).toBe('AudioContext is not available');
    expect(stopped).toBe(1);
  });
});
