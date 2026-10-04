import { createContext } from 'react';

import type { CognitoAuth, TokenSet } from './cognito/flows';

export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

export interface AuthContextValue {
  status: AuthStatus;
  /** Localizable error key from the last sign-in attempt, if any. */
  errorKey: string | null;
  /** Localizable notice for the sign-in form (the session ended without an error), if any. */
  noticeKey: string | null;
  /** The session came from the session cookie (a reload or a new tab), not from a sign-in. */
  restored: boolean;
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
  /** Access token with enough lifetime left for a chat turn, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /** Gets new tokens now (e.g. after a group assignment); false if the session ended. */
  refreshSession: () => Promise<boolean>;
  /** Drops the tokens in memory (e.g. after a 401 from the API). */
  expireSession: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
