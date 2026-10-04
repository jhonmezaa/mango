import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { RuntimeConfig } from '../config/runtimeConfig';
import { safeReturnPath } from '../security/safeUrl';
import { AuthContext, type AuthContextValue, type AuthStatus } from './AuthContext';
import type { CognitoAuth, TokenSet } from './cognito/flows';
import { displayEmailFromIdToken, subjectOf } from './jwt';
import { createServerSession, type RenewResult, type ServerSession } from './serverSession';
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

// The same for the session cookie: one restore per page load, shared by both effect runs.
const restorePromises = new WeakMap<ServerSession, Promise<RenewResult>>();

function restore(serverSession: ServerSession): Promise<RenewResult> {
  let promise = restorePromises.get(serverSession);
  if (!promise) {
    promise = serverSession.renew();
    restorePromises.set(serverSession, promise);
  }
  return promise;
}

/** Tells the other tabs that this one signed out. No data travels in the message. */
const SIGNED_OUT = 'signed-out';
const CHANNEL = 'mango-auth';

/**
 * Tokens in memory. `refreshToken` is only there while the server does not hold the session
 * (right after the sign-in, or when the session cookie could not be set).
 */
interface Session {
  accessToken: string;
  idToken: string;
  expiresAt: number;
  refreshToken?: string;
}

function currentPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

interface Props {
  config: RuntimeConfig;
  cognito: CognitoAuth;
  /** The session cookie of mango-api; tests pass a double. */
  serverSession?: ServerSession;
  children: ReactNode;
}

/**
 * Session for the own login (SRP) and for SSO (D20, D63, REACT-AUTH-001).
 *
 * - Access and ID tokens live only in a ref. The refresh token goes to mango-api right after
 *   the sign-in, which keeps it in an `HttpOnly` cookie this code cannot read; from then on
 *   new tokens come from `POST /api/session/refresh`, also after a reload.
 * - If the server cannot take the session, the refresh token stays in memory and the session
 *   works as before: it renews against Cognito and ends with the page.
 * - Every renewal runs the pre-token trigger again, so group changes apply without a new
 *   sign-in.
 * - Signing out ends the server session (which revokes the refresh token) in every tab. SSO
 *   sessions also end the Cognito managed-login session.
 */
export function AuthProvider({ config, cognito, serverSession: injected, children }: Props) {
  const serverSession = useMemo(
    () => injected ?? createServerSession(config.apiBasePath),
    [injected, config.apiBasePath],
  );
  // Either the SSO callback or the session cookie decides: nothing is shown before that.
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [displayEmail, setDisplayEmail] = useState<string | null>(null);
  const tokens = useRef<Session | null>(null);
  const federated = useRef(false);
  const refreshing = useRef<Promise<Session | null> | null>(null);

  const setSession = useCallback((next: Session | null) => {
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

  /** Starts the session with the tokens of a completed sign-in and hands it to the server. */
  const adopt = useCallback(
    (next: TokenSet, isFederated: boolean) => {
      federated.current = isFederated;
      setSession(next);
      setErrorKey(null);
      setStatus('authenticated');
      void serverSession.start(next.accessToken, next.refreshToken, isFederated).then((taken) => {
        // The server holds it now: JavaScript no longer needs the refresh token.
        if (taken && tokens.current === next) {
          tokens.current = {
            accessToken: next.accessToken,
            idToken: next.idToken,
            expiresAt: next.expiresAt,
          };
        }
      });
    },
    [serverSession, setSession],
  );

  // A reload (or a new tab) recovers the session from the cookie, without a new sign-in.
  useEffect(() => {
    if (hasAuthCallbackParams(window.location.search)) return;
    let cancelled = false;
    void restore(serverSession).then((result) => {
      // A sign-in that finished meanwhile wins.
      if (cancelled || tokens.current) return;
      if (result.kind !== 'ok') {
        setStatus('unauthenticated');
        return;
      }
      federated.current = result.session.federated;
      setSession(result.session);
      setStatus('authenticated');
    });
    return () => {
      cancelled = true;
    };
  }, [serverSession, setSession]);

  // Signing out in one tab signs out the others: they share the cookie that just ended.
  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const opened = new BroadcastChannel(CHANNEL);
    channel.current = opened;
    opened.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === SIGNED_OUT && tokens.current) endSession(null);
    };
    return () => {
      channel.current = null;
      opened.close();
    };
  }, [endSession]);

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
        adopt(next, true);
      },
      () => {
        window.history.replaceState(null, '', '/');
        if (!cancelled) endSession('auth.errors.signInFailed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adopt, config, endSession]);

  const acceptTokens = useCallback(
    (next: TokenSet) => {
      adopt(next, false);
    },
    [adopt],
  );

  /** New tokens from Cognito (session in memory) or from the session cookie. */
  const renew = useCallback(
    async (current: Session): Promise<Session | null> => {
      if (current.refreshToken !== undefined) {
        try {
          return await cognito.refresh(current.refreshToken);
        } catch {
          endSession('auth.errors.sessionExpired');
          return null;
        }
      }
      const result = await serverSession.renew();
      if (result.kind === 'none') {
        endSession('auth.errors.sessionExpired');
        return null;
      }
      // An outage says nothing about the session: keep it and let the caller retry.
      if (result.kind === 'unavailable') return null;
      if (subjectOf(result.session.accessToken) !== subjectOf(current.accessToken)) {
        // Somebody else signed in from another tab: nothing of this tab's state is theirs.
        window.location.reload();
        return null;
      }
      return result.session;
    },
    [cognito, endSession, serverSession],
  );

  const refresh = useCallback((): Promise<Session | null> => {
    const current = tokens.current;
    if (!current) return Promise.resolve(null);
    // One refresh at a time: parallel API calls share it.
    refreshing.current ??= renew(current)
      .then((next) => {
        if (next && tokens.current === current) setSession(next);
        return next;
      })
      .finally(() => {
        refreshing.current = null;
      });
    return refreshing.current;
  }, [renew, setSession]);

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
    channel.current?.postMessage(SIGNED_OUT);
    if (current?.refreshToken !== undefined) {
      try {
        await cognito.revoke(current.refreshToken);
      } catch {
        // Best effort: the tokens are already gone from memory.
      }
    }
    // Always: a cookie may exist even when this tab never learned that it was set.
    await serverSession.end();
    if (wasFederated) window.location.assign(logoutUrl(config));
  }, [cognito, config, endSession, serverSession]);

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
