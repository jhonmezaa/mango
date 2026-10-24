import { z } from 'zod';

const displayClaims = z.object({ email: z.string().max(254).optional() }).loose();
const authTimeClaims = z.object({ auth_time: z.number().int().positive() }).loose();
const subjectClaims = z.object({ sub: z.string().min(1).max(256) }).loose();
const groupClaims = z
  .object({ 'cognito:groups': z.array(z.string().max(128)).max(100).optional() })
  .loose();

function payloadOf(token: string): unknown {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Reads the ID token's `email` for display only. The signature is not checked here: nothing in
 * the SPA authorizes with it (mango-api verifies the access token, REACT-AUTHZ-001).
 */
export function displayEmailFromIdToken(idToken: string): string | null {
  const parsed = displayClaims.safeParse(payloadOf(idToken));
  return parsed.success ? (parsed.data.email ?? null) : null;
}

/**
 * The ID token's groups, for display only: the screen of a bu-lead Mango refuses names its area
 * groups (403 `area_required`, D60 (10)). Never to authorize: mango-api decides from the
 * verified access token (REACT-AUTHZ-001).
 */
export function displayGroupsFromIdToken(idToken: string): string[] {
  const parsed = groupClaims.safeParse(payloadOf(idToken));
  return parsed.success ? (parsed.data['cognito:groups'] ?? []) : [];
}

/**
 * The `sub` of a token, unverified: only to notice that the shared session cookie now belongs
 * to somebody else (another sign-in in another tab), never to authorize anything.
 */
export function subjectOf(token: string): string | null {
  const parsed = subjectClaims.safeParse(payloadOf(token));
  return parsed.success ? parsed.data.sub : null;
}

/**
 * When the person signed in (`auth_time`, epoch seconds), unverified. Cognito keeps it across
 * renewals, and mango-api counts the maximum session from it. Display only: it times the notice
 * before the session ends; the server is what ends it.
 */
export function authTimeOf(token: string): number | null {
  const parsed = authTimeClaims.safeParse(payloadOf(token));
  return parsed.success ? parsed.data.auth_time : null;
}
