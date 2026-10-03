import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { RuntimeConfig } from '../config/runtimeConfig';
import { safeReturnPath } from '../security/safeUrl';
import { AuthContext, type AuthContextValue, type AuthStatus } from './AuthContext';
import type { CognitoAuth, TokenSet } from './cognito/flows';
import { displayEmailFromIdToken } from './jwt';
import { hasAuthCallbackParams, logoutUrl } from './ssoUrls';

/** mango-api rejects tokens with less than timeoutSeconds + 60 s left (TM-I5); renew before that. */
const MIN_TOKEN_TTL_SECONDS = 360;

// The authorization code is single-use; StrictMode runs effects twice, so the callback promise
// is memoized per URL to avoid redeeming it twice.
const callbackPromises = new Map<string, ReturnType<typeof runSsoCallback>>();

async function runSsoCallback(config: RuntimeConfig, url: string) {
  const { completeSsoCallback, createUserManager } = await import('./oidc');
  return completeSsoCallback(createUserManager(config), url);
}

function currentPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

interface Props {
  config: RuntimeConfig;
  cognito: CognitoAuth;
  children: ReactNode;
}

/**
 * In-memory session for the own login (SRP) and for SSO (D20, REACT-AUTH-001).
 *
 * - Access, ID and refresh tokens live only in a ref: a reload means signing in again (with MFA).
 * - Tokens are refreshed on demand with `REFRESH_TOKEN_AUTH`; the pre-token trigger runs again,
 *   so group changes apply without a new sign-in.
 * - Signing out revokes the refresh token (and the access tokens issued from it). SSO sessions
 *   also end the Cognito managed-login session.
 */
export function AuthProvider({ config, cognito, children }: Props) {
  const [status, setStatus] = useState<AuthStatus>(() =>
    hasAuthCallbackParams(window.location.search) ? 'loading' : 'unauthenticated',
  );
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [displayEmail, setDisplayEmail] = useState<string | null>(null);
  const tokens = useRef<TokenSet | null>(null);
  const federated = useRef(false);
  const refreshing = useRef<Promise<TokenSet | null> | null>(null);

  const setSession = useCallback((next: TokenSet | null) => {
    tokens.current = next;
    setDisplayEmail(next ? displayEmailFromIdToken(next.idToken) : null);
  }, []);

  const endSession = useCallback(
    (key: string | null) => {
      setSession(null);
      federated.current = false;
      setErrorKey(key);
      setStatus('unauthenticated');
    },
    [setSession],
  );

  useEffect(() => {
    if (!hasAuthCallbackParams(window.location.search)) return;
    let cancelled = false;
    const url = window.location.href;
    let promise = callbackPromises.get(url);
    if (!promise) {
      promise = runSsoCallback(config, url);
      callbackPromises.set(url, promise);
    }
    promise.then(
      ({ state, ...next }) => {
        // Strip `code`/`state` from the address bar and history; only a validated in-app path
        // from our own sign-in state is honored (REACT-REDIRECT-001).
        window.history.replaceState(null, '', safeReturnPath(state));
        if (cancelled) return;
        federated.current = true;
        setSession(next);
        setStatus('authenticated');
      },
      () => {
        window.history.replaceState(null, '', '/');
        if (!cancelled) endSession('auth.errors.signInFailed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [config, endSession, setSession]);

  const acceptTokens = useCallback(
    (next: TokenSet) => {
      federated.current = false;
      setSession(next);
      setErrorKey(null);
      setStatus('authenticated');
    },
    [setSession],
  );

  const refresh = useCallback((): Promise<TokenSet | null> => {
    const current = tokens.current;
    if (!current) return Promise.resolve(null);
    // One refresh at a time: parallel API calls share it.
    refreshing.current ??= cognito
      .refresh(current.refreshToken)
      .then(
        (next) => {
          if (tokens.current === current) setSession(next);
          return next;
        },
        () => {
          endSession('auth.errors.sessionExpired');
          return null;
        },
      )
      .finally(() => {
        refreshing.current = null;
      });
    return refreshing.current;
  }, [cognito, endSession, setSession]);

  const getAccessToken = useCallback(async () => {
    const current = tokens.current;
    if (!current) return null;
    if (current.expiresAt - Date.now() >= MIN_TOKEN_TTL_SECONDS * 1000) return current.accessToken;
    return (await refresh())?.accessToken ?? null;
  }, [refresh]);

  const refreshSession = useCallback(async () => (await refresh()) !== null, [refresh]);

  const logout = useCallback(async () => {
    const current = tokens.current;
    const wasFederated = federated.current;
    endSession(null);
    if (current) {
      try {
        await cognito.revoke(current.refreshToken);
      } catch {
        // Best effort: the tokens are already gone from memory.
      }
    }
    if (wasFederated) window.location.assign(logoutUrl(config));
  }, [cognito, config, endSession]);

  const expireSession = useCallback(() => {
    endSession('auth.errors.sessionExpired');
  }, [endSession]);

  const startSso = useCallback(async () => {
    if (!config.ssoProvider) return;
    setErrorKey(null);
    const { createUserManager } = await import('./oidc');
    await createUserManager(config).signinRedirect({
      state: currentPath(),
      extraQueryParams: { identity_provider: config.ssoProvider },
    });
  }, [config]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      errorKey,
      cognito,
      acceptTokens,
      ssoAvailable: Boolean(config.ssoProvider),
      startSso,
      displayEmail,
      logout,
      getAccessToken,
      refreshSession,
      expireSession,
    }),
    [
      status,
      errorKey,
      cognito,
      acceptTokens,
      config.ssoProvider,
      startSso,
      displayEmail,
      logout,
      getAccessToken,
      refreshSession,
      expireSession,
    ],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
