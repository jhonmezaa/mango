import { z } from 'zod';

import { RETURN_RESULTS, SESSION_URI } from './model';

/**
 * The hop between the return page and the tab that pressed «Conectar» (D100 (2)): a
 * `BroadcastChannel`, which only reaches pages of the same origin in this browser.
 *
 * - The return page sends `return` with the `session_id` and nothing else, plus a random `ref`
 *   that ties the answers to that page; or `provider` when the provider came back without one.
 * - The waiting tab answers `claimed` as soon as it takes it, and `result` when mango-api answered,
 *   with the service's name for «Listo» (never a token, a URL or the `session_id`).
 *
 * Every message is validated before use: anything else on the channel is ignored. The `session_id`
 * is never written to Web Storage, cookies, the URL or a log (P-9, TM-016).
 */

export const CONSENT_CHANNEL = 'mango-consent';

const ref = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
const name = z.string().min(1).max(200);

const message = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('return'), ref, session_id: z.string().regex(SESSION_URI) }),
  z.strictObject({ kind: z.literal('provider'), result: z.enum(['denied', 'error']) }),
  z.strictObject({ kind: z.literal('claimed'), ref }),
  z.strictObject({
    kind: z.literal('result'),
    ref,
    result: z.enum(RETURN_RESULTS),
    service: name.optional(),
    idp: name.optional(),
  }),
]);

export type ConsentMessage = z.infer<typeof message>;

export function parseConsentMessage(data: unknown): ConsentMessage | null {
  const parsed = message.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Opens the channel; null where the browser has none (the return then says «Pídelo de nuevo»). */
export function openConsentChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CONSENT_CHANNEL);
}

/** A random reference of the return page, not a secret. */
export function newReturnRef(): string {
  return crypto.randomUUID();
}
