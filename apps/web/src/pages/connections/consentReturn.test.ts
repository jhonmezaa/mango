import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import {
  captureConsentReturn,
  capturedReturn,
  completeConsentOnce,
  resetConsentReturn,
} from './consentReturn';

const SESSION = 'urn:ietf:params:oauth:request_uri:abc-DEF_123.x~y';

function at(pathname: string, search: string) {
  const replaceState = vi.fn();
  captureConsentReturn({ pathname, search, hash: '' }, { replaceState, state: { k: 1 } });
  return replaceState;
}

afterEach(() => {
  resetConsentReturn();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('captureConsentReturn (P-9)', () => {
  it('keeps the session id in memory only and removes it from the URL', () => {
    const replaceState = at('/conexiones/vuelta', `?session_id=${encodeURIComponent(SESSION)}`);
    expect(capturedReturn()).toEqual({ kind: 'session', sessionId: SESSION });
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, '', '/conexiones/vuelta');
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });

  it('turns anything else into a failed return, still clearing the query', () => {
    const replaceState = at('/conexiones/vuelta', '?session_id=https://evil.example/x');
    expect(capturedReturn()).toEqual({ kind: 'failed', result: 'error' });
    expect(replaceState).toHaveBeenCalledOnce();
    resetConsentReturn();
    at('/conexiones/vuelta', '?error=access_denied&error_description=<b>x</b>');
    expect(capturedReturn()).toEqual({ kind: 'failed', result: 'denied' });
  });

  it('ignores other paths and a bare return path', () => {
    expect(at('/', `?session_id=${SESSION}`)).not.toHaveBeenCalled();
    expect(at('/conexiones/vuelta', '')).not.toHaveBeenCalled();
    expect(capturedReturn()).toBeNull();
  });
});

describe('completeConsentOnce', () => {
  it('posts once per session id and forgets it when settled', async () => {
    at('/conexiones/vuelta', `?session_id=${SESSION}`);
    const call = vi.fn(() =>
      Promise.resolve({ status: 'connected', registration_id: 'abcdefghij23', profile_id: 'p' }),
    );
    const api = { call } as unknown as ApiClient;
    const first = completeConsentOnce(api, SESSION);
    const second = completeConsentOnce(api, SESSION);
    expect(second).toBe(first);
    await first;
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('completeConsent', { body: { session_id: SESSION } });
    expect(capturedReturn()).toBeNull();
  });
});
