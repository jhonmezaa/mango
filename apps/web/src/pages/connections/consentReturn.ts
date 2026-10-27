import type { ApiClient } from '../../api/client';
import type { OperationOutput } from '../../api/operations';
import { RETURN_PATH, SESSION_URI, returnResultOfQuery, type ReturnResult } from './model';

/**
 * The return from AgentCore Identity (P-1): `/conexiones/vuelta?session_id=…`.
 *
 * The `session_id` is read once, when the app starts, kept **only in memory** and removed from the
 * URL right away (`history.replaceState`), before any sign-in screen or request: it never stays in
 * the address bar, the history, a Referer or Web Storage (P-9, TM-016). Without a session, the
 * sign-in of Mango (SRP) does not reload the page, so the value is still here when it ends; after a
 * full redirect (federated sign-in) it is gone and the person presses «Conectar» again.
 */

export type CapturedReturn =
  { kind: 'session'; sessionId: string } | { kind: 'failed'; result: ReturnResult };

let captured: CapturedReturn | null = null;
type Callback = OperationOutput<'completeConsent'>;
let completion: { sessionId: string; promise: Promise<Callback> } | null = null;

/** Reads and clears the return query; call it before the first render (main.tsx). */
export function captureConsentReturn(
  location: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location,
  history: Pick<History, 'replaceState' | 'state'> = window.history,
): void {
  if (location.pathname !== RETURN_PATH || !location.search) return;
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session_id');
  if (sessionId !== null && SESSION_URI.test(sessionId)) {
    captured = { kind: 'session', sessionId };
  } else {
    captured = { kind: 'failed', result: returnResultOfQuery(params.get('error')) };
  }
  history.replaceState(history.state, '', `${RETURN_PATH}${location.hash}`);
}

/** What the start of the app captured; null when it did not come back from the provider. */
export function capturedReturn(): CapturedReturn | null {
  return captured;
}

/**
 * Closes the consent once per `session_id`: the same promise for a second call (StrictMode runs
 * effects twice) and, once it settles, the value is dropped from memory.
 */
export function completeConsentOnce(api: ApiClient, sessionId: string): Promise<Callback> {
  if (completion?.sessionId === sessionId) return completion.promise;
  const promise = api.call('completeConsent', { body: { session_id: sessionId } });
  completion = { sessionId, promise };
  const forget = () => {
    if (captured?.kind === 'session' && captured.sessionId === sessionId) captured = null;
  };
  promise.then(forget, forget);
  return promise;
}

/** Tests only. */
export function resetConsentReturn(): void {
  captured = null;
  completion = null;
}
