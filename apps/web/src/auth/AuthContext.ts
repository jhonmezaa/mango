import { createContext } from 'react';

import type { CognitoAuth, TokenSet } from './cognito/flows';

/**
 * `unavailable`: at load, the server could not say whether this browser has a session (outage,
 * network, rate limit). Neither the sign-in form nor the application is shown; the person
 * retries.
 */
export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated' | 'unavailable';

export interface AuthContextValue {
  status: AuthStatus;
  /** Localizable error key from the last sign-in attempt, if any. */
  errorKey: string | null;
  /** Localizable notice for the sign-in form (the session ended without an error), if any. */
  noticeKey: string | null;
  /** The session came from the session cookie (a reload or a new tab), not from a sign-in. */
  restored: boolean;
  /** The sign-in was with the IdP of the company (SSO), not with the own login. Display only. */
  federated: boolean;
  /**
   * Epoch milliseconds when the session reaches its maximum duration, or null when unknown.
   * Display only (the notice before it ends): mango-api is what ends the session.
   */
  sessionEndsAt: number | null;
  /** Own login flows against Cognito (SRP, MFA, sign-up, recovery). */
  cognito: CognitoAuth;
  /** Starts the session with the tokens of a completed sign-in. */
  acceptTokens: (tokens: TokenSet) => void;
  /** Whether the installation has an IdP ("Continuar con SSO"). */
  ssoAvailable: boolean;
  /** Redirects to the customer's IdP through the Cognito managed login (code + PKCE). */
  startSso: () => Promise<void>;
  /** Email of the signed-in user, from the ID token; display only. */
  displayEmail: string | null;
  logout: () => Promise<void>;
  /** Asks the server again whether this browser has a session (status `unavailable`). */
  retryRestore: () => void;
  /**
   * Access token with enough lifetime left for a chat turn, or null when signed out. Rejects
   * with an `ApiError` (503 or 429) when the renewal did not answer: the session is kept.
   */
  getAccessToken: () => Promise<string | null>;
  /**
   * Gets new tokens now (e.g. after a group assignment); false if it could not (the session
   * ended, or the renewal did not answer and the session is kept).
   */
  refreshSession: () => Promise<boolean>;
  /** Drops the tokens in memory (e.g. after a 401 from the API). */
  expireSession: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
