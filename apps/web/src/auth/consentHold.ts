/**
 * The access token of a tab that waits for a consent return (D100 (3)).
 *
 * AgentCore Identity only completes a consent with the same access token that asked for it, so the
 * tab that pressed «Conectar» must still hold that token when the return arrives (at most 10
 * minutes, what the consent URL lives). «Conectar» renews the session right before asking for the
 * URL, so the token has most of its hour left; while the hold lasts, the SPA does not renew it on
 * its own (`refreshSession`) as long as it is still valid. Renewals that cannot wait (the token is
 * about to expire) still happen, and the generation tells the waiting tab its token changed.
 *
 * Module state, in memory only: nothing here is a secret, and nothing is stored.
 */

let heldUntil = 0;
let generation = 0;

/** Keeps the current token until `ms` from now, or until `releaseToken`. */
export function holdToken(ms: number, now: number = Date.now()): void {
  heldUntil = now + ms;
}

export function releaseToken(): void {
  heldUntil = 0;
}

export function tokenHeld(now: number = Date.now()): boolean {
  return now < heldUntil;
}

/** Changes every time the tab gets a different access token. */
export function tokenGeneration(): number {
  return generation;
}

/** The AuthProvider calls it when the access token of the tab changes. */
export function noteNewToken(): void {
  generation += 1;
}

/** Tests only. */
export function resetConsentHold(): void {
  heldUntil = 0;
  generation = 0;
}
