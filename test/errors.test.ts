import { describe, expect, it } from 'vitest';
import { HueError, type HueErrorOptions, type HueErrorReason, isHueError } from '../src/index.js';

describe('HueError', () => {
  it('carries its reason, v1 code, HTTP status and cause', () => {
    const cause = new TypeError('fetch failed');
    const options: HueErrorOptions = { code: 7, status: 200, cause };
    const error = new HueError('rejected', 'invalid value', options);
    expect(error).toMatchObject({ name: 'HueError', reason: 'rejected', code: 7, status: 200, cause });
    expect(isHueError(error, 'rejected')).toBe(true);
    expect(isHueError(error, 'unauthorized')).toBe(false);
  });

  it("has a reason for the relay's own refusal, apart from a refused Hue session", () => {
    const forbidden: HueErrorReason = 'forbidden';
    const error = new HueError(forbidden, 'Not allowed to use this relay.', { status: 403 });
    expect(isHueError(error, 'forbidden')).toBe(true);
    expect(isHueError(error, 'unauthorized')).toBe(false);
  });
});
