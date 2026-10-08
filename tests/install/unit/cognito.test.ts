import { describe, expect, it, vi } from 'vitest';

import {
  describeRefusal,
  isCodeRefusal,
  refusalOf,
  withOneRetry,
  type Attempt,
  type Refusal,
} from '../src/cognito.ts';

const used: Refusal = { status: 400, name: 'ExpiredCodeException' };
const refused = (refusal: Refusal): Attempt<string> => ({ ok: false, refusal });
const signedIn: Attempt<string> = { ok: true, value: 'session' };

describe('refusalOf', () => {
  it('reads the exception name, bare or with its namespace', () => {
    expect(refusalOf(400, { __type: 'CodeMismatchException' }).name).toBe('CodeMismatchException');
    expect(refusalOf(400, { __type: 'com.amazonaws.cognito#ExpiredCodeException' })).toEqual(used);
  });

  it('keeps nothing else of the body, and nothing that is not a name', () => {
    const body = { __type: 'ExpiredCodeException', message: 'token 123456 was used' };
    expect(JSON.stringify(refusalOf(400, body))).not.toContain('123456');
    expect(refusalOf(400, { __type: 'not a name: 123456' }).name).toBe('Http400');
    expect(refusalOf(403, '<html>blocked</html>').name).toBe('Http403');
    expect(refusalOf(429, null).name).toBe('Http429');
    expect(refusalOf(400, { __type: 7 }).name).toBe('Http400');
  });
});

describe('isCodeRefusal', () => {
  it('is true for a wrong code and for one already used, and for nothing else', () => {
    expect(isCodeRefusal({ status: 400, name: 'CodeMismatchException' })).toBe(true);
    expect(isCodeRefusal(used)).toBe(true);
    expect(isCodeRefusal({ status: 400, name: 'NotAuthorizedException' })).toBe(false);
    expect(isCodeRefusal({ status: 429, name: 'Http429' })).toBe(false);
  });
});

describe('describeRefusal', () => {
  it('says the code was refused and why it usually is', () => {
    const text = describeRefusal(used, 2);
    expect(text).toContain('Cognito refused the TOTP code (ExpiredCodeException) twice');
    expect(text).toContain('another process is signing in as this same test user');
    expect(text).toContain('secrets file');
    expect(describeRefusal(used, 1)).not.toContain('twice');
  });

  it('names any other refusal and says it was not tried again', () => {
    expect(describeRefusal({ status: 400, name: 'NotAuthorizedException' }, 1)).toBe(
      'Cognito refused the sign-in at the code step (NotAuthorizedException): the sign-in ' +
        'attempt expired or Cognito ended it. It was not tried again.',
    );
    expect(describeRefusal({ status: 500, name: 'Http500' }, 1)).toBe(
      'Cognito refused the sign-in at the code step (Http500). It was not tried again.',
    );
  });
});

describe('withOneRetry', () => {
  it('does not try again a sign-in that worked', async () => {
    const attempt = vi.fn(() => Promise.resolve(signedIn));
    const onCodeRefused = vi.fn();
    await expect(withOneRetry(attempt, onCodeRefused)).resolves.toBe('session');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onCodeRefused).not.toHaveBeenCalled();
  });

  it('tries once more after a refused code, and tells the caller in between', async () => {
    const order: string[] = [];
    const answers = [refused(used), signedIn];
    const attempt = vi.fn(() => {
      order.push('attempt');
      return Promise.resolve(answers.shift() ?? signedIn);
    });
    const value = await withOneRetry(attempt, (refusal) => order.push(refusal.name));
    expect(value).toBe('session');
    expect(order).toEqual(['attempt', 'ExpiredCodeException', 'attempt']);
  });

  it('never tries a third time: a second refusal fails saying the code was refused', async () => {
    const attempt = vi.fn(() => Promise.resolve(refused(used)));
    await expect(withOneRetry(attempt, () => undefined)).rejects.toThrow(
      /^Cognito refused the TOTP code \(ExpiredCodeException\) twice/,
    );
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not try again what is not a refused code', async () => {
    const attempt = vi.fn(() =>
      Promise.resolve(refused({ status: 400, name: 'NotAuthorizedException' })),
    );
    const onCodeRefused = vi.fn();
    await expect(withOneRetry(attempt, onCodeRefused)).rejects.toThrow('It was not tried again.');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onCodeRefused).not.toHaveBeenCalled();
  });

  it('fails with the second refusal when that one is not about the code', async () => {
    const answers = [refused(used), refused({ status: 429, name: 'TooManyRequestsException' })];
    const attempt = vi.fn(() => Promise.resolve(answers.shift() ?? signedIn));
    await expect(withOneRetry(attempt, () => undefined)).rejects.toThrow(
      'Cognito refused the sign-in at the code step (TooManyRequestsException)',
    );
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
