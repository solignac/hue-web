/** Monotonic clock: a system clock change must neither stall pacing nor skew latency. */
export const now = (): number => performance.now();

/** Resolves after `ms`. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Like {@link sleep}, but resolves early when `signal` aborts. */
export function sleepUnless(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms);
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/** `promise`, or `fallback` if it takes longer than `ms`. Never rejects on timeout. */
export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Statuses whose Response cannot be built with a body, even an empty one.
const NULL_BODY = new Set([204, 205, 304]);

/**
 * `fetch` with a deadline, body included: the answer comes back fully read. A
 * hung request (bridge gone quiet, slow gateway) would otherwise block whatever
 * awaits it, an effect's stop barrier included. Built on a plain controller
 * rather than `AbortSignal.timeout` for older Safari.
 */
export async function fetchWithin(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    // Headers are not the answer: a connection that dies mid-body would hang the
    // read for good (browsers have no body timeout), so it is read under the deadline.
    const body = await response.arrayBuffer();
    const { status, statusText, headers } = response;
    return new Response(NULL_BODY.has(status) ? null : body, { status, statusText, headers });
  } finally {
    clearTimeout(timer);
  }
}

/** `globalThis.fetch`, resolved at call time so tests and polyfills can swap it. */
export const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
