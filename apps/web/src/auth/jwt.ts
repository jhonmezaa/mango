import { z } from 'zod';

const displayClaims = z.object({ email: z.string().max(254).optional() }).loose();

/**
 * Reads the ID token's `email` for display only. The signature is not checked here: nothing in
 * the SPA authorizes with it (mango-api verifies the access token, REACT-AUTHZ-001).
 */
export function displayEmailFromIdToken(idToken: string): string | null {
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
    const parsed = displayClaims.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? (parsed.data.email ?? null) : null;
  } catch {
    return null;
  }
}
