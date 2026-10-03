import { InMemoryWebStorage, UserManager, WebStorageStateStore } from 'oidc-client-ts';

import type { RuntimeConfig } from '../config/runtimeConfig';
import { cognitoIssuer, redirectUri } from './ssoUrls';

/**
 * OAuth 2.0 authorization code + PKCE against the Cognito managed login, used only for the SSO
 * redirect to the customer's IdP (D20). Loaded on demand: the own login does not need it.
 *
 * - Tokens (access, ID, refresh) live only in memory (InMemoryWebStorage) and are handed to the
 *   AuthProvider right after the callback: nothing survives a reload and an XSS cannot read
 *   them from Web Storage (REACT-AUTH-001, TM-012).
 * - The transient sign-in state (`state` + PKCE `code_verifier`) must survive the full-page
 *   redirect to Cognito, so it uses sessionStorage. It is single-use, removed by
 *   signinRedirectCallback, and holds no tokens.
 * - Endpoints are set explicitly (no discovery fetch) from the validated runtime config.
 */
export function createUserManager(config: RuntimeConfig): UserManager {
  const issuer = cognitoIssuer(config);
  return new UserManager({
    authority: issuer,
    metadata: {
      issuer,
      authorization_endpoint: `${config.cognitoDomain}/oauth2/authorize`,
      token_endpoint: `${config.cognitoDomain}/oauth2/token`,
      revocation_endpoint: `${config.cognitoDomain}/oauth2/revoke`,
      userinfo_endpoint: `${config.cognitoDomain}/oauth2/userInfo`,
    },
    client_id: config.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid',
    loadUserInfo: false,
    monitorSession: false,
    // The AuthProvider refreshes with REFRESH_TOKEN_AUTH, the same as for the own login.
    automaticSilentRenew: false,
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    // eslint-disable-next-line no-restricted-properties -- transient PKCE state only, see above.
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
  });
}

/** Hands the callback's tokens over, then forgets them here (single in-memory owner). */
export async function completeSsoCallback(
  userManager: UserManager,
  url: string,
): Promise<{
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresAt: number;
  state: unknown;
}> {
  const user = await userManager.signinRedirectCallback(url);
  await userManager.removeUser();
  if (!user.id_token || !user.refresh_token || !user.expires_at) {
    throw new Error('incomplete token response');
  }
  return {
    accessToken: user.access_token,
    idToken: user.id_token,
    refreshToken: user.refresh_token,
    expiresAt: user.expires_at * 1000,
    state: user.state,
  };
}
