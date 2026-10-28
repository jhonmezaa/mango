import { newReturnRef, openConsentChannel, parseConsentMessage } from './consentChannel';
import { takeConsentReturn } from './consentReturn';
import type { ReturnResult } from './model';

/** Without an answer from a tab in this time, no tab asked for it (design: «unos 3 s»). */
export const CLAIM_WAIT_MS = 3000;
/** A tab took it but mango-api did not answer it in this time. */
export const RESULT_WAIT_MS = 60_000;
/** «Listo» stays this long before the page tries to close itself (design: «unos 2 s»). */
export const CLOSE_AFTER_MS = 2000;

export interface Outcome {
  result: ReturnResult;
  service: string | null;
  idp: string | null;
}

/** Several tabs answered and none closed it: the most telling answer (`notyours` last). */
function pick(results: readonly ReturnResult[]): ReturnResult {
  return results.find((result) => result !== 'notyours') ?? 'notyours';
}

/**
 * Hands the `session_id` to the tab that pressed «Conectar» and waits for its answer (D100 (2)).
 * Nothing here calls mango-api: Identity only accepts the token of that tab. It runs once per page
 * load (StrictMode mounts twice; both get the same answer).
 */
function runRelay(): Promise<Outcome> {
  const unnamed = (result: ReturnResult): Outcome => ({ result, service: null, idp: null });
  const captured = takeConsentReturn();
  // Nothing in memory: the page was reloaded. The consent can only be asked again.
  if (!captured) return Promise.resolve(unnamed('orphan'));
  const channel = openConsentChannel();
  if (captured.kind === 'failed') {
    // The provider came back without a session id: say it here, and to the waiting tab.
    channel?.postMessage({ kind: 'provider', result: captured.result });
    channel?.close();
    return Promise.resolve(unnamed(captured.result));
  }
  if (!channel) return Promise.resolve(unnamed('orphan'));
  return new Promise<Outcome>((resolve) => {
    const ref = newReturnRef();
    let claims = 0;
    const results: ReturnResult[] = [];
    const settle = (next: Outcome) => {
      window.clearTimeout(claimTimer);
      window.clearTimeout(resultTimer);
      channel.onmessage = null;
      channel.close();
      resolve(next);
    };
    const claimTimer = window.setTimeout(() => {
      if (claims === 0) settle(unnamed('orphan'));
    }, CLAIM_WAIT_MS);
    const resultTimer = window.setTimeout(() => {
      settle(unnamed(results.length ? pick(results) : 'error'));
    }, RESULT_WAIT_MS);
    channel.onmessage = (event: MessageEvent) => {
      const message = parseConsentMessage(event.data);
      if (!message || !('ref' in message) || message.ref !== ref) return;
      if (message.kind === 'claimed') {
        claims += 1;
        return;
      }
      if (message.kind !== 'result') return;
      if (message.result === 'ok') {
        settle({ result: 'ok', service: message.service ?? null, idp: message.idp ?? null });
        return;
      }
      results.push(message.result);
      if (results.length >= claims) settle(unnamed(pick(results)));
    };
    // Only the session id, once; it leaves this page's memory with the message.
    channel.postMessage({ kind: 'return', ref, session_id: captured.sessionId });
  });
}

let relay: Promise<Outcome> | null = null;

/** The relay of this page load: one per load, shared by StrictMode's two mounts. */
export function relayOnce(): Promise<Outcome> {
  relay ??= runRelay();
  return relay;
}

/** Tests only. */
export function resetReturnRelay(): void {
  relay = null;
}
