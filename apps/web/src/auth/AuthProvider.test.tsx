import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeConfig } from '../config/runtimeConfig';
import type { AuthContextValue } from './AuthContext';
import { AuthProvider } from './AuthProvider';
import { CognitoError } from './cognito/api';
import type { CognitoAuth, TokenSet } from './cognito/flows';
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

function setup(cognito: Partial<CognitoAuth> = {}) {
  const fake = {
    refresh: vi.fn(() => Promise.resolve(tokens(3600, 'access-2'))),
    revoke: vi.fn(() => Promise.resolve()),
    ...cognito,
  };
  const ref: { current: AuthContextValue | null } = { current: null };
  function Probe() {
    ref.current = useAuth();
    return <p>{ref.current.status}</p>;
  }
  render(
    <AuthProvider config={config} cognito={fake as unknown as CognitoAuth}>
      <Probe />
    </AuthProvider>,
  );
  const auth = () => {
    if (!ref.current) throw new Error('no context');
    return ref.current;
  };
  return { fake, auth };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthProvider (in-memory session)', () => {
  it('starts signed out and accepts the tokens of a completed sign-in', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { auth } = setup();
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
    const { fake, auth } = setup();
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
    const { auth } = setup({
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
    const { fake, auth } = setup();
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
    vi.unstubAllGlobals();
  });

  it('forces a refresh to pick up a new group assignment', async () => {
    const { fake, auth } = setup();
    act(() => {
      auth().acceptTokens(tokens(3600));
    });
    await act(async () => {
      await expect(auth().refreshSession()).resolves.toBe(true);
    });
    expect(fake.refresh).toHaveBeenCalledOnce();
  });
});
