import type { RuntimeConfig } from '../config/runtimeConfig';

/** URL helpers for the SSO redirect; no oidc-client-ts import, so they stay in the main chunk. */

export function cognitoIssuer(config: RuntimeConfig): string {
  return config.issuer ?? `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
}

export function redirectUri(): string {
  return `${window.location.origin}/`;
}

export function logoutUrl(config: RuntimeConfig): string {
  const url = new URL(`${config.cognitoDomain}/logout`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('logout_uri', redirectUri());
  return url.toString();
}

export function hasAuthCallbackParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has('state') && (params.has('code') || params.has('error'));
}
