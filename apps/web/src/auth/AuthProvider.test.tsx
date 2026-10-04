import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeConfig } from '../config/runtimeConfig';
import type { AuthContextValue } from './AuthContext';
import { AuthProvider } from './AuthProvider';
import { CognitoError } from './cognito/api';
import type { CognitoAuth, TokenSet } from './cognito/flows';
import type { RenewResult, ServerSession } from './serverSession';
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it.each<RenewResult>([{ kind: 'none' }, { kind: 'unavailable' }])(
    'goes to the sign-in without an error when there is no session ($kind)',
    async (result) => {
      const { auth } = await setup({}, { renew: vi.fn(() => Promise.resolve(result)) });
      expect(screen.getByText('unauthenticated')).toBeInTheDocument();
      expect(auth().errorKey).toBeNull();
    },
  );

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
    await act(async () => {
      await expect(auth().getAccessToken()).resolves.toBeNull();
    });
    expect(screen.getByText('authenticated')).toBeInTheDocument();
    session.renew.mockResolvedValue(renewed());
    await act(async () => {
      await expect(auth().getAccessToken()).resolves.toBe(jwt({ sub: 'ana', n: 2 }));
    });
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
  });
});
