import { describe, expect, it } from 'vitest';
import { createLocalTransport, createRelayClient, requestKey } from '../src/index.js';
import { fetchWithin, within } from '../src/internal/async.js';

/**
 * Headers, the start of a body, then silence: a connection that died mid-answer.
 * Like `fetch`, an abort of the request's signal errors the body being read.
 */
const stalled: typeof fetch = async (_input, init) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[{"success":'));
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('fetchWithin', () => {
  it('gives up on a body that stalls after the headers, for every caller', async () => {
    const outcomes = await within<unknown>(
      Promise.all(
        [
          createLocalTransport({ host: 'x', appKey: 'k', fetch: stalled, timeoutMs: 50 }).getLights(),
          createRelayClient({ url: 'https://relay.example', fetch: stalled, timeoutMs: 50 }).authorizeUrl('s'),
          requestKey('x', { fetch: stalled, timeoutMs: 50 }),
        ].map((p) => p.catch((e: unknown) => e)),
      ),
      2000,
      'hung',
    );
    expect(outcomes).toEqual([
      expect.objectContaining({ name: 'HueError', reason: 'unreachable' }),
      expect.objectContaining({ name: 'HueError', reason: 'unreachable' }),
      expect.objectContaining({ name: 'HueError', reason: 'unreachable' }),
    ]);
  });

  it('hands over the answer as received, empty ones included', async () => {
    const answer: typeof fetch = async (input) =>
      String(input).endsWith('/empty')
        ? new Response(null, { status: 204, statusText: 'No Content' })
        : Response.json({ ok: 1 }, { status: 503, statusText: 'Busy', headers: { 'retry-after': '2' } });
    const full = await fetchWithin(answer, 'https://x/full', {}, 1000);
    expect([full.status, full.statusText, full.headers.get('retry-after'), await full.json()]).toEqual([
      503,
      'Busy',
      '2',
      { ok: 1 },
    ]);
    const empty = await fetchWithin(answer, 'https://x/empty', {}, 1000);
    expect([empty.status, await empty.text()]).toEqual([204, '']);
  });
});
