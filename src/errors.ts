/**
 * Why a Hue call failed, as something code can branch on.
 *
 * - `unreachable`: no answer (offline, timeout, certificate not yet accepted in
 *   this browser, local network access denied).
 * - `unauthorized`: the bridge refused the application key, or the Hue cloud
 *   session expired or was revoked. Pair again or reconnect Hue.
 * - `forbidden`: your relay refused this caller (its `authorize` hook, or the
 *   gateway in front of it). Sign in to your app again; Hue access is
 *   unaffected, there is nothing to reconnect.
 * - `link-button`: pairing needs the bridge's link button to be pressed.
 * - `rate-limited`: the remote API throttled the call (HTTP 429).
 * - `unavailable`: a gateway or the bridge behind it is down (HTTP 5xx), what
 *   answered is not a Hue bridge or not your relay (check the address), the
 *   token store cannot be read, or Philips refused your relay's own client
 *   credentials (its configuration: reconnecting Hue cannot fix that).
 * - `unsupported`: this transport cannot do that (CLIP v2 from a web page to a
 *   local bridge).
 * - `rejected`: the bridge or the API answered and said no.
 * - `aborted`: cancelled through its `signal`: a command not sent because the
 *   effect that owned it was stopped, or a pairing cancelled.
 */
export type HueErrorReason =
  | 'unreachable'
  | 'unauthorized'
  | 'forbidden'
  | 'link-button'
  | 'rate-limited'
  | 'unavailable'
  | 'unsupported'
  | 'rejected'
  | 'aborted';

// A record rather than a list, so a reason added to the type above cannot be forgotten here.
const REASONS: Readonly<Record<HueErrorReason, true>> = {
  unreachable: true,
  unauthorized: true,
  forbidden: true,
  'link-button': true,
  'rate-limited': true,
  unavailable: true,
  unsupported: true,
  rejected: true,
  aborted: true,
};
const KNOWN: ReadonlySet<string> = new Set(Object.keys(REASONS));

/** Is `value` one of the {@link HueErrorReason}s? For reasons that arrive over the wire. */
export function isHueErrorReason(value: unknown): value is HueErrorReason {
  return typeof value === 'string' && KNOWN.has(value);
}

/** Details of a {@link HueError}, all optional. */
export interface HueErrorOptions {
  /** CLIP v1 error type (1 = unauthorized user, 101 = link button not pressed…). */
  code?: number | undefined;
  /** HTTP status, when one was received. */
  status?: number | undefined;
  /** What failed underneath (a `fetch` error, a storage error), kept as `Error.cause`. */
  cause?: unknown;
}

/**
 * What every failed Hue call throws. Programming errors (a malformed hex colour
 * or device type) are `TypeError`s instead: no retry or reconnection fixes them.
 */
export class HueError extends Error {
  override readonly name = 'HueError';
  /** Why it failed: what code should branch on. */
  readonly reason: HueErrorReason;
  /** CLIP v1 error type, when the bridge sent one. */
  readonly code: number | undefined;
  /** HTTP status, when one was received. */
  readonly status: number | undefined;

  constructor(reason: HueErrorReason, message: string, options: HueErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.reason = reason;
    this.code = options.code;
    this.status = options.status;
  }
}

/** Narrows `error` to a {@link HueError}, optionally of a given reason. */
export function isHueError(error: unknown, reason?: HueErrorReason): error is HueError {
  return error instanceof HueError && (reason === undefined || error.reason === reason);
}

/** CLIP v1 error type → reason. */
export function reasonForCode(code: number | undefined): HueErrorReason {
  if (code === 1) return 'unauthorized';
  if (code === 101) return 'link-button';
  return 'rejected';
}

/** HTTP status → reason. */
export function reasonForStatus(status: number): HueErrorReason {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'unavailable';
  return 'rejected';
}

/** Wraps anything thrown into a {@link HueError}. */
export function toHueError(error: unknown): HueError {
  if (error instanceof HueError) return error;
  return new HueError('rejected', error instanceof Error ? error.message : String(error), { cause: error });
}

/** The error of something cancelled: by default, a command not sent because its effect was stopped. */
export function abortedError(message = 'Command not sent: the effect was stopped.'): HueError {
  return new HueError('aborted', message);
}

/** Throws {@link abortedError} once `signal` has aborted: nothing more may be sent. */
export function throwIfAborted(signal: AbortSignal | undefined, message?: string): void {
  if (signal?.aborted) throw abortedError(message);
}
