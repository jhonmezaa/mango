import { createContext } from 'react';

import type { CognitoAuth, TokenSet } from './cognito/flows';

export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

export interface AuthContextValue {
  status: AuthStatus;
  /** Localizable error key from the last sign-in attempt, if any. */
  errorKey: string | null;
  /** Own login flows against Cognito (SRP, MFA, sign-up, recovery). */
  cognito: CognitoAuth;
  /** Starts the in-memory session with the tokens of a completed sign-in. */
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
  /** Drops the in-memory session (e.g. after a 401 from the API). */
  expireSession: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
