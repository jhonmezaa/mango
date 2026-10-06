import { z } from 'zod';

import { parseRetryAfter } from '../api/errors';

/**
 * The session cookie of mango-api (D63). The cookie is `HttpOnly`: this code never sees it,
 * and it only buys new tokens. Every other API call keeps sending the access token and no
 * cookie (`credentials: 'omit'` in `api/client.ts`).
 *
 * - The custom header is the CSRF guard of these endpoints (REACT-CSRF-001): a form cannot
 *   send it and, with no CORS on the API, neither can a script from another site.
 * - Nothing is written to Web Storage (REACT-AUTH-001).
 */

const SESSION_HEADER = { 'X-Mango-Session': '1' };
const MAX_TOKEN = 16_384;

const renewedSchema = z.object({
  access_token: z.string().min(1).max(MAX_TOKEN),
  id_token: z.string().min(1).max(MAX_TOKEN),
  expires_in: z.number().int().positive().max(86_400),
  federated: z.boolean(),
});

export interface RenewedSession {
  accessToken: string;
  idToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
  federated: boolean;
}

export type RenewResult =
  | { kind: 'ok'; session: RenewedSession }
  /** There is no session (never was, expired, signed out or revoked). */
  | { kind: 'none' }
  /**
   * The answer is unknown (network, outage, rate limit): the session may still exist.
   * `rateLimited` is a 429; `retryAfter` are the seconds of its `Retry-After`, when usable.
   */
  | { kind: 'unavailable'; rateLimited?: true; retryAfter?: number };

export interface ServerSession {
  /** Hands the refresh token of a completed sign-in to the server. False if it did not take. */
  start: (accessToken: string, refreshToken: string, federated: boolean) => Promise<boolean>;
  renew: () => Promise<RenewResult>;
  /** Signs out on the server: revokes the refresh token and removes the cookie. */
  end: () => Promise<void>;
}

export function createServerSession(
  basePath: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  now: () => number = Date.now,
): ServerSession {
  const call = (
    path: string,
    method: 'POST' | 'DELETE',
    headers: Record<string, string> = {},
    body?: string,
  ) =>
    fetchImpl(`${basePath}/session${path}`, {
      method,
      headers: { ...SESSION_HEADER, Accept: 'application/json', ...headers },
      body: body ?? null,
      // Same origin only: the cookie never leaves the application's own origin.
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });

  return {
    async start(accessToken, refreshToken, federated) {
      try {
        const response = await call(
          '',
          'POST',
          { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          JSON.stringify({ refresh_token: refreshToken, federated }),
        );
        return response.ok;
      } catch {
        return false;
      }
    },

    async renew() {
      let response: Response;
      try {
        response = await call('/refresh', 'POST');
      } catch {
        return { kind: 'unavailable' };
      }
      // 204: the server holds no session for this browser (it is not an error).
      if (response.status === 204) return { kind: 'none' };
      // Only the 204 says the session is over. A 429 (the API's own limit or the edge), a 5xx
      // or anything else leaves the question open.
      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
        return {
          kind: 'unavailable',
          rateLimited: true,
          ...(retryAfter === null ? {} : { retryAfter }),
        };
      }
      if (!response.ok) return { kind: 'unavailable' };
      const parsed = renewedSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) return { kind: 'unavailable' };
      return {
        kind: 'ok',
        session: {
          accessToken: parsed.data.access_token,
          idToken: parsed.data.id_token,
          expiresAt: now() + parsed.data.expires_in * 1000,
          federated: parsed.data.federated,
        },
      };
    },

    async end() {
      try {
        await call('', 'DELETE');
      } catch {
        // Best effort: the tokens are already gone from memory.
      }
    },
  };
}

/**
 * Waits before asking again at load when the renewal did not answer (5xx, network): three more
 * tries in about 7 s, behind «Recuperando tu sesión…». A short outage (a task being replaced)
 * passes unseen; a longer one ends in the error with «Reintentar». A 429 is not retried: asking
 * again is what a rate limit must not get.
 */
export const RESTORE_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The check at load: `renew`, asked again while the answer stays unknown. */
export async function renewWithRetries(serverSession: ServerSession): Promise<RenewResult> {
  let result = await serverSession.renew();
  for (const delay of RESTORE_RETRY_DELAYS_MS) {
    if (result.kind !== 'unavailable' || result.rateLimited) break;
    await wait(delay);
    result = await serverSession.renew();
  }
  return result;
}
