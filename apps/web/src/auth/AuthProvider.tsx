import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { sessionUnavailableError } from '../api/errors';
import type { RuntimeConfig } from '../config/runtimeConfig';
import { safeReturnPath } from '../security/safeUrl';
import { AuthContext, type AuthContextValue, type AuthStatus } from './AuthContext';
import { CognitoError } from './cognito/api';
import type { CognitoAuth, TokenSet } from './cognito/flows';
import { authTimeOf, displayEmailFromIdToken, subjectOf } from './jwt';
import {
  createServerSession,
  renewWithRetries,
  type RenewResult,
  type ServerSession,
} from './serverSession';
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
    promise = renewWithRetries(serverSession);
    restorePromises.set(serverSession, promise);
  }
  return promise;
}

/** Cognito refuses the refresh token: the same two answers that end a session in mango-api. */
const REFRESH_REJECTED: ReadonlySet<string> = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
]);

/** Tells the other tabs that this one signed out. No data travels in the message. */
const SIGNED_OUT = 'signed-out';
const SIGNED_OUT_ELSEWHERE = 'auth.signedOutElsewhere';
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

/** What a renewal says about the session. Only `ended` sends the person to the sign-in. */
type Renewal =
  | { kind: 'ok'; session: Session }
  | { kind: 'ended' }
  /** Nobody said the session ended (outage, network, rate limit): it is kept. */
  | { kind: 'unavailable'; rateLimited?: true; retryAfter?: number };

const ENDED: Renewal = { kind: 'ended' };

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
  const [noticeKey, setNoticeKey] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [sessionEndsAt, setSessionEndsAt] = useState<number | null>(null);
  const [displayEmail, setDisplayEmail] = useState<string | null>(null);
  const tokens = useRef<Session | null>(null);
  const federated = useRef(false);
  // Same value as the ref, for what is shown (the ref is for callbacks that must not change).
  const [isFederatedSession, setIsFederatedSession] = useState(false);
  const setFederated = useCallback((value: boolean) => {
    federated.current = value;
    setIsFederatedSession(value);
  }, []);
  const refreshing = useRef<Promise<Renewal> | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);

  const sessionSeconds = config.auth.sessionHours * 3600;
  const setSession = useCallback(
    (next: Session | null) => {
      tokens.current = next;
      setDisplayEmail(next ? displayEmailFromIdToken(next.idToken) : null);
      // Same rule as mango-api: the maximum counts from the sign-in, not from a renewal.
      const authTime = next ? authTimeOf(next.accessToken) : null;
      setSessionEndsAt(authTime === null ? null : (authTime + sessionSeconds) * 1000);
    },
    [sessionSeconds],
  );

  const endSession = useCallback(
    (key: string | null, notice: string | null = null) => {
      setSession(null);
      setFederated(false);
      setErrorKey(key);
      setNoticeKey(notice);
      setRestored(false);
      setStatus('unauthenticated');
    },
    [setSession, setFederated],
  );

  /** Starts the session with the tokens of a completed sign-in and hands it to the server. */
  const adopt = useCallback(
    (next: TokenSet, isFederated: boolean) => {
      setFederated(isFederated);
      setSession(next);
      setErrorKey(null);
      setNoticeKey(null);
      setRestored(false);
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
    [serverSession, setSession, setFederated],
  );

  // A reload (or a new tab) recovers the session from the cookie, without a new sign-in.
  useEffect(() => {
    if (hasAuthCallbackParams(window.location.search)) return;
    let cancelled = false;
    void restore(serverSession).then((result) => {
      // A sign-in that finished meanwhile wins.
      if (cancelled || tokens.current) return;
      if (result.kind === 'none') {
        setStatus('unauthenticated');
        return;
      }
      if (result.kind === 'unavailable') {
        // Not the sign-in form: the server did not say there is no session.
        setStatus('unavailable');
        return;
      }
      setFederated(result.session.federated);
      setSession(result.session);
      setRestored(true);
      setStatus('authenticated');
    });
    return () => {
      cancelled = true;
    };
  }, [serverSession, setSession, setFederated, restoreAttempt]);

  const retryRestore = useCallback(() => {
    restorePromises.delete(serverSession);
    setStatus('loading');
    setRestoreAttempt((attempt) => attempt + 1);
  }, [serverSession]);

  // Signing out in one tab signs out the others: they share the cookie that just ended.
  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const opened = new BroadcastChannel(CHANNEL);
    channel.current = opened;
    opened.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === SIGNED_OUT && tokens.current) endSession(null, SIGNED_OUT_ELSEWHERE);
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
    async (current: Session): Promise<Renewal> => {
      if (current.refreshToken !== undefined) {
        try {
          return { kind: 'ok', session: await cognito.refresh(current.refreshToken) };
        } catch (error) {
          // Throttling, an outage or the network say nothing about the session either.
          if (!(error instanceof CognitoError && REFRESH_REJECTED.has(error.code))) {
            return { kind: 'unavailable' };
          }
          endSession('auth.errors.sessionExpired');
          return ENDED;
        }
      }
      const result = await serverSession.renew();
      if (result.kind === 'none') {
        endSession('auth.errors.sessionExpired');
        return ENDED;
      }
      // An outage says nothing about the session: keep it and let the caller retry.
      if (result.kind === 'unavailable') return result;
      if (subjectOf(result.session.accessToken) !== subjectOf(current.accessToken)) {
        // Somebody else signed in from another tab: nothing of this tab's state is theirs.
        window.location.reload();
        return ENDED;
      }
      return result;
    },
    [cognito, endSession, serverSession],
  );

  const refresh = useCallback((): Promise<Renewal> => {
    const current = tokens.current;
    if (!current) return Promise.resolve(ENDED);
    // One refresh at a time: parallel API calls share it.
    refreshing.current ??= renew(current)
      .then((next) => {
        if (next.kind === 'ok' && tokens.current === current) setSession(next.session);
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
    const renewal = await refresh();
    // Not null: null means signed out, and the callers send the person to the sign-in.
    if (renewal.kind === 'unavailable') throw sessionUnavailableError(renewal);
    return renewal.kind === 'ok' ? renewal.session.accessToken : null;
  }, [refresh]);

  const refreshSession = useCallback(async () => (await refresh()).kind === 'ok', [refresh]);

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
      noticeKey,
      restored,
      federated: isFederatedSession,
      sessionEndsAt,
      cognito,
      acceptTokens,
      ssoAvailable: Boolean(config.ssoProvider),
      startSso,
      displayEmail,
      logout,
      retryRestore,
      getAccessToken,
      refreshSession,
      expireSession,
    }),
    [
      status,
      errorKey,
      noticeKey,
      restored,
      isFederatedSession,
      sessionEndsAt,
      cognito,
      acceptTokens,
      config.ssoProvider,
      startSso,
      displayEmail,
      logout,
      retryRestore,
      getAccessToken,
      refreshSession,
      expireSession,
    ],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
