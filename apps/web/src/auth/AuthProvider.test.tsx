import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/errors';

import type { RuntimeConfig } from '../config/runtimeConfig';
import type { AuthContextValue } from './AuthContext';
import { AuthProvider } from './AuthProvider';
import { CognitoError } from './cognito/api';
import type { CognitoAuth, TokenSet } from './cognito/flows';
import { RESTORE_RETRY_DELAYS_MS, type RenewResult, type ServerSession } from './serverSession';
import { useAuth } from './useAuth';

const config = {
  region: 'us-east-1',
  cognitoDomain: 'https://auth.example.com',
  userPoolId: 'us-east-1_Test',
  clientId: 'client',
  apiBasePath: '/api',
  signUpDomains: ['empresa.com'],
  auth: { installationType: 'customer', mfa: 'required', sessionHours: 12 },
} as RuntimeConfig;

const idToken = `h.${btoa(JSON.stringify({ email: 'ana@empresa.com' }))}.s`;

function tokens(ttlSeconds: number, access = 'access-1'): TokenSet {
  return {
    accessToken: access,
    idToken,
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
}

const jwt = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims))}.s`;

function renewed(sub = 'ana', access = jwt({ sub, n: 2 })): RenewResult {
  return {
    kind: 'ok',
    session: { accessToken: access, idToken, expiresAt: Date.now() + 3_600_000, federated: false },
  };
}

/** Renders the provider and waits for the session cookie to be checked. */
async function setup(cognito: Partial<CognitoAuth> = {}, server: Partial<ServerSession> = {}) {
  const fake = {
    refresh: vi.fn(() => Promise.resolve(tokens(3600, 'access-2'))),
    revoke: vi.fn(() => Promise.resolve()),
    ...cognito,
  };
  // By default the server holds no session and takes none: the session stays in memory.
  const session = {
    start: vi.fn(() => Promise.resolve(false)),
    end: vi.fn(() => Promise.resolve()),
    ...server,
    renew: vi.fn(server.renew ?? ((): Promise<RenewResult> => Promise.resolve({ kind: 'none' }))),
  };
  const ref: { current: AuthContextValue | null } = { current: null };
  function Probe() {
    ref.current = useAuth();
    return <p>{ref.current.status}</p>;
  }
  render(
    <AuthProvider config={config} cognito={fake as unknown as CognitoAuth} serverSession={session}>
      <Probe />
    </AuthProvider>,
  );
  await act(async () => {});
  const auth = () => {
    if (!ref.current) throw new Error('no context');
    return ref.current;
  };
  return { fake, session, auth };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** What `getAccessToken` rejects with while the renewal does not answer. */
async function tokenFailure(auth: () => AuthContextValue): Promise<unknown> {
  let failure: unknown = null;
  await act(async () => {
    failure = await auth()
      .getAccessToken()
      .catch((error: unknown) => error);
  });
  return failure;
}

describe('AuthProvider (session in memory: the server did not take it)', () => {
  it('starts signed out and accepts the tokens of a completed sign-in', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { auth } = await setup();
    expect(screen.getByText('unauthenticated')).toBeInTheDocument();
    act(() => {
      auth().acceptTokens(tokens(3600));
    });
    expect(screen.getByText('authenticated')).toBeInTheDocument();
    expect(auth().displayEmail).toBe('ana@empresa.com');
    expect(auth().ssoAvailable).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('returns the token while it lives long enough, then refreshes once for parallel calls', async () => {
    const { fake, auth } = await setup();
    act(() => {
      auth().acceptTokens(tokens(3600));
    });
    await expect(auth().getAccessToken()).resolves.toBe('access-1');
    expect(fake.refresh).not.toHaveBeenCalled();

    act(() => {
      auth().acceptTokens(tokens(60));
    });
    let results: (string | null)[] = [];
    await act(async () => {
      results = await Promise.all([auth().getAccessToken(), auth().getAccessToken()]);
    });
    expect(results).toEqual(['access-2', 'access-2']);
    expect(fake.refresh).toHaveBeenCalledOnce();
    expect(fake.refresh).toHaveBeenCalledWith('refresh-1');
  });

  it('ends the session when the refresh fails', async () => {
    const { auth } = await setup({
      refresh: vi.fn(() => Promise.reject(new CognitoError('NotAuthorizedException'))),
    });
    act(() => {
      auth().acceptTokens(tokens(10));
    });
    await act(async () => {
      await expect(auth().getAccessToken()).resolves.toBeNull();
    });
    expect(screen.getByText('unauthenticated')).toBeInTheDocument();
    expect(auth().errorKey).toBe('auth.errors.sessionExpired');
  });

  it.each(['NetworkError', 'TooManyRequestsException', 'InternalErrorException', 'Http503'])(
    'keeps the session when Cognito does not answer the refresh (%s)',
    async (code) => {
      let down = true;
      const { auth } = await setup({
        refresh: vi.fn(() =>
          down ? Promise.reject(new CognitoError(code)) : Promise.resolve(tokens(3600, 'access-2')),
        ),
      });
      act(() => {
        auth().acceptTokens(tokens(10));
      });
      const failure = await tokenFailure(auth);
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({ status: 503, code: 'session_unavailable' });
      expect(screen.getByText('authenticated')).toBeInTheDocument();
      expect(auth().errorKey).toBeNull();
      // The next call asks again, and the session goes on.
      down = false;
      await act(async () => {
        await expect(auth().getAccessToken()).resolves.toBe('access-2');
      });
    },
  );

  it('ends the session when Cognito says the user is gone', async () => {
    const { auth } = await setup({
      refresh: vi.fn(() => Promise.reject(new CognitoError('UserNotFoundException'))),
    });
    act(() => {
      auth().acceptTokens(tokens(10));
    });
    await act(async () => {
      await expect(auth().getAccessToken()).resolves.toBeNull();
    });
    expect(screen.getByText('unauthenticated')).toBeInTheDocument();
    expect(auth().errorKey).toBe('auth.errors.sessionExpired');
  });

  it('revokes the refresh token on sign-out and forgets the tokens', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', {
      assign,
      search: '',
      href: 'http://localhost/',
      origin: 'http://localhost',
    });
    const { fake, auth } = await setup();
    act(() => {
      auth().acceptTokens(tokens(3600));
    });
    await act(async () => {
      await auth().logout();
    });
    expect(fake.revoke).toHaveBeenCalledWith('refresh-1');
    expect(screen.getByText('unauthenticated')).toBeInTheDocument();
    await expect(auth().getAccessToken()).resolves.toBeNull();
    // Own-login sessions do not go through the managed-login logout.
    expect(assign).not.toHaveBeenCalled();
  });

  it('forces a refresh to pick up a new group assignment', async () => {
    const { fake, auth } = await setup();
    act(() => {
      auth().acceptTokens(tokens(3600));
    });
    await act(async () => {
      await expect(auth().refreshSession()).resolves.toBe(true);
    });
    expect(fake.refresh).toHaveBeenCalledOnce();
  });
});

describe('AuthProvider (session cookie of the server, D63)', () => {
  const signedIn = (access = jwt({ sub: 'ana', n: 1 })) => ({ ...tokens(3600, access) });

  it('shows nothing until the cookie was checked, then recovers the session of a reload', async () => {
    let answer: (result: RenewResult) => void = () => undefined;
    const renew = vi.fn(() => new Promise<RenewResult>((resolve) => (answer = resolve)));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { auth, fake } = await setup({}, { renew });
    expect(screen.getByText('loading')).toBeInTheDocument();
    await act(async () => {
      answer(renewed());
      await Promise.resolve();
    });
    expect(screen.getByText('authenticated')).toBeInTheDocument();
    expect(auth().displayEmail).toBe('ana@empresa.com');
    await expect(auth().getAccessToken()).resolves.toBe(jwt({ sub: 'ana', n: 2 }));
    expect(renew).toHaveBeenCalledOnce();
    expect(fake.refresh).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('goes to the sign-in without an error when the server says there is no session', async () => {
    const renew = vi.fn((): Promise<RenewResult> => Promise.resolve({ kind: 'none' }));
    const { auth } = await setup({}, { renew });
    expect(screen.getByText('unauthenticated')).toBeInTheDocument();
    expect(auth().errorKey).toBeNull();
    expect(renew).toHaveBeenCalledOnce();
  });

  describe('at load, when the renewal does not answer', () => {
    const allDelays = RESTORE_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

    it('asks again a few times before giving up, and never shows the sign-in form', async () => {
      vi.useFakeTimers();
      const { auth, session } = await setup(
        {},
        { renew: () => Promise.resolve({ kind: 'unavailable' }) },
      );
      // Still «Recuperando tu sesión…» while it retries.
      expect(screen.getByText('loading')).toBeInTheDocument();
      expect(session.renew).toHaveBeenCalledOnce();
      await advance(RESTORE_RETRY_DELAYS_MS[0] ?? 0);
      expect(session.renew).toHaveBeenCalledTimes(2);
      expect(screen.getByText('loading')).toBeInTheDocument();
      await advance(allDelays);
      expect(session.renew).toHaveBeenCalledTimes(1 + RESTORE_RETRY_DELAYS_MS.length);
      expect(screen.getByText('unavailable')).toBeInTheDocument();
      expect(auth().errorKey).toBeNull();
      // Nothing more goes out until the person retries, and no session was ended.
      await advance(60_000);
      expect(session.renew).toHaveBeenCalledTimes(1 + RESTORE_RETRY_DELAYS_MS.length);
      expect(session.end).not.toHaveBeenCalled();
    });

    it('recovers the session when the renewal comes back during the retries', async () => {
      vi.useFakeTimers();
      const answers: RenewResult[] = [{ kind: 'unavailable' }, { kind: 'unavailable' }, renewed()];
      const { auth, session } = await setup(
        {},
        { renew: () => Promise.resolve(answers.shift() ?? { kind: 'none' }) },
      );
      await advance(allDelays);
      expect(screen.getByText('authenticated')).toBeInTheDocument();
      expect(auth().restored).toBe(true);
      expect(session.renew).toHaveBeenCalledTimes(3);
    });

    it('goes to the sign-in as soon as an answer says there is no session', async () => {
      vi.useFakeTimers();
      const answers: RenewResult[] = [{ kind: 'unavailable' }, { kind: 'none' }];
      const { session } = await setup(
        {},
        { renew: () => Promise.resolve(answers.shift() ?? { kind: 'none' }) },
      );
      await advance(allDelays);
      expect(screen.getByText('unauthenticated')).toBeInTheDocument();
      expect(session.renew).toHaveBeenCalledTimes(2);
    });

    it('does not ask again on its own after a rate limit', async () => {
      vi.useFakeTimers();
      const { session } = await setup(
        {},
        {
          renew: () => Promise.resolve({ kind: 'unavailable', rateLimited: true, retryAfter: 30 }),
        },
      );
      expect(screen.getByText('unavailable')).toBeInTheDocument();
      await advance(60_000);
      expect(session.renew).toHaveBeenCalledOnce();
    });

    it('asks again when the person retries, and then recovers the session', async () => {
      const { auth, session } = await setup(
        {},
        { renew: () => Promise.resolve({ kind: 'unavailable', rateLimited: true }) },
      );
      expect(screen.getByText('unavailable')).toBeInTheDocument();
      session.renew.mockResolvedValue(renewed());
      await act(async () => {
        auth().retryRestore();
        await Promise.resolve();
      });
      expect(await screen.findByText('authenticated')).toBeInTheDocument();
      expect(session.renew).toHaveBeenCalledTimes(2);
    });

    it('goes to the sign-in when the retry says there is no session', async () => {
      const { auth, session } = await setup(
        {},
        { renew: () => Promise.resolve({ kind: 'unavailable', rateLimited: true }) },
      );
      session.renew.mockResolvedValue({ kind: 'none' });
      await act(async () => {
        auth().retryRestore();
        await Promise.resolve();
      });
      expect(await screen.findByText('unauthenticated')).toBeInTheDocument();
      expect(auth().errorKey).toBeNull();
    });
  });

  it('hands the refresh token to the server and stops using it', async () => {
    const start = vi.fn(() => Promise.resolve(true));
    const { auth, fake, session } = await setup({}, { start });
    const first = signedIn();
    await act(async () => {
      auth().acceptTokens({ ...first, expiresAt: Date.now() + 60_000 });
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledWith(first.accessToken, 'refresh-1', false);

    session.renew.mockResolvedValue(renewed());
    let results: (string | null)[] = [];
    await act(async () => {
      results = await Promise.all([auth().getAccessToken(), auth().getAccessToken()]);
    });
    // Renewed by the server, once for both calls; Cognito is no longer asked.
    expect(results).toEqual([jwt({ sub: 'ana', n: 2 }), jwt({ sub: 'ana', n: 2 })]);
    expect(session.renew).toHaveBeenCalledTimes(2); // the check at load and this renewal
    expect(fake.refresh).not.toHaveBeenCalled();
  });

  it('ends the session when the server says it is over', async () => {
    const { auth, session } = await setup({}, { start: vi.fn(() => Promise.resolve(true)) });
    await act(async () => {
      auth().acceptTokens({ ...signedIn(), expiresAt: Date.now() + 10_000 });
      await Promise.resolve();
    });
    session.renew.mockResolvedValue({ kind: 'none' });
    await act(async () => {
      await expect(auth().getAccessToken()).resolves.toBeNull();
    });
    expect(screen.getByText('unauthenticated')).toBeInTheDocument();
    expect(auth().errorKey).toBe('auth.errors.sessionExpired');
  });

  it('keeps the session through an outage of the renewal', async () => {
    const { auth, session } = await setup({}, { start: vi.fn(() => Promise.resolve(true)) });
    await act(async () => {
      auth().acceptTokens({ ...signedIn(), expiresAt: Date.now() + 10_000 });
      await Promise.resolve();
    });
    session.renew.mockResolvedValue({ kind: 'unavailable' });
    // Not null: null is what sends the person to the sign-in.
    const failure = await tokenFailure(auth);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 503, code: 'session_unavailable' });
    expect(screen.getByText('authenticated')).toBeInTheDocument();
    expect(auth().errorKey).toBeNull();
    await act(async () => {
      await expect(auth().refreshSession()).resolves.toBe(false);
    });
    expect(screen.getByText('authenticated')).toBeInTheDocument();
    session.renew.mockResolvedValue(renewed());
    await act(async () => {
      await expect(auth().getAccessToken()).resolves.toBe(jwt({ sub: 'ana', n: 2 }));
    });
  });

  it('keeps the session through a rate limit of the renewal, and passes its wait on', async () => {
    const { auth, session } = await setup({}, { start: vi.fn(() => Promise.resolve(true)) });
    await act(async () => {
      auth().acceptTokens({ ...signedIn(), expiresAt: Date.now() + 10_000 });
      await Promise.resolve();
    });
    session.renew.mockResolvedValue({ kind: 'unavailable', rateLimited: true, retryAfter: 120 });
    expect(await tokenFailure(auth)).toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfter: 120,
    });
    expect(screen.getByText('authenticated')).toBeInTheDocument();
  });

  it('does not sign the other tabs out when its renewal is down', async () => {
    const { auth, session } = await setup({}, { start: vi.fn(() => Promise.resolve(true)) });
    await act(async () => {
      auth().acceptTokens({ ...signedIn(), expiresAt: Date.now() + 10_000 });
      await Promise.resolve();
    });
    const other = new BroadcastChannel('mango-auth');
    const heard = vi.fn<(event: MessageEvent<unknown>) => void>();
    other.onmessage = heard;
    session.renew.mockResolvedValue({ kind: 'unavailable' });
    await tokenFailure(auth);
    await tokenFailure(auth);
    // A message that does go out arrives first: nothing was posted before it.
    const probe = new BroadcastChannel('mango-auth');
    probe.postMessage('probe');
    await vi.waitFor(() => {
      expect(heard).toHaveBeenCalled();
    });
    probe.close();
    other.close();
    expect(heard.mock.calls.map(([event]) => event.data)).toEqual(['probe']);
    // The cookie the tabs share is untouched: no sign-out reached the server.
    expect(session.end).not.toHaveBeenCalled();
    expect(screen.getByText('authenticated')).toBeInTheDocument();
  });

  it('reloads instead of mixing two people when the cookie changed hands', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload, search: '', href: 'http://localhost/' });
    const { auth, session } = await setup({}, { start: vi.fn(() => Promise.resolve(true)) });
    await act(async () => {
      auth().acceptTokens({ ...signedIn(), expiresAt: Date.now() + 10_000 });
      await Promise.resolve();
    });
    session.renew.mockResolvedValue(renewed('luis'));
    await act(async () => {
      await expect(auth().getAccessToken()).resolves.toBeNull();
    });
    expect(reload).toHaveBeenCalledOnce();
  });

  it('signs out on the server, without asking Cognito for a token it no longer has', async () => {
    const { auth, fake, session } = await setup({}, { start: vi.fn(() => Promise.resolve(true)) });
    await act(async () => {
      auth().acceptTokens(signedIn());
      await Promise.resolve();
    });
    await act(async () => {
      await auth().logout();
    });
    expect(session.end).toHaveBeenCalledOnce();
    expect(fake.revoke).not.toHaveBeenCalled();
    expect(screen.getByText('unauthenticated')).toBeInTheDocument();
  });

  it('signs out when another tab did', async () => {
    const { auth } = await setup({}, { start: vi.fn(() => Promise.resolve(true)) });
    act(() => {
      auth().acceptTokens(signedIn());
    });
    const other = new BroadcastChannel('mango-auth');
    other.postMessage('signed-out');
    await screen.findByText('unauthenticated');
    other.close();
    expect(auth().errorKey).toBeNull();
    expect(auth().noticeKey).toBe('auth.signedOutElsewhere');
  });

  it('says nothing on the sign-in form after signing out in this tab', async () => {
    const { auth } = await setup();
    act(() => {
      auth().acceptTokens(tokens(3600));
    });
    await act(async () => {
      await auth().logout();
    });
    expect(auth().noticeKey).toBeNull();
  });

  it('knows when the session ends from the sign-in time, also after a reload', async () => {
    const authTime = Math.floor(Date.now() / 1000) - 3600;
    const access = jwt({ sub: 'ana', auth_time: authTime });
    const { auth } = await setup({}, { renew: () => Promise.resolve(renewed('ana', access)) });
    await screen.findByText('authenticated');
    expect(auth().restored).toBe(true);
    // 12 h of `sessionHours` from the sign-in, not from the renewal.
    expect(auth().sessionEndsAt).toBe((authTime + 12 * 3600) * 1000);
  });

  it('does not guess the end of a session whose token has no sign-in time', async () => {
    const { auth } = await setup();
    act(() => {
      auth().acceptTokens(tokens(3600));
    });
    expect(auth().restored).toBe(false);
    expect(auth().sessionEndsAt).toBeNull();
  });
});
