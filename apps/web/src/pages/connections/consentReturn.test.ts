import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureConsentReturn,
  isConsentReturnPage,
  resetConsentReturn,
  takeConsentReturn,
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
    expect(takeConsentReturn()).toEqual({ kind: 'session', sessionId: SESSION });
    // Handed over once: it leaves memory with it.
    expect(takeConsentReturn()).toBeNull();
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, '', '/conexiones/vuelta');
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });

  it('turns anything else into a failed return, still clearing the query', () => {
    const replaceState = at('/conexiones/vuelta', '?session_id=https://evil.example/x');
    expect(takeConsentReturn()).toEqual({ kind: 'failed', result: 'error' });
    expect(replaceState).toHaveBeenCalledOnce();
    resetConsentReturn();
    at('/conexiones/vuelta', '?error=access_denied&error_description=<b>x</b>');
    expect(takeConsentReturn()).toEqual({ kind: 'failed', result: 'denied' });
  });

  it('ignores other paths and a bare return path', () => {
    expect(at('/', `?session_id=${SESSION}`)).not.toHaveBeenCalled();
    expect(at('/conexiones/vuelta', '')).not.toHaveBeenCalled();
    expect(takeConsentReturn()).toBeNull();
  });

  it('knows the return page by its path', () => {
    expect(isConsentReturnPage('/conexiones/vuelta')).toBe(true);
    expect(isConsentReturnPage('/')).toBe(false);
  });
});
