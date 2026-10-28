import { RETURN_PATH, SESSION_URI, returnResultOfQuery } from './model';

/**
 * The return from AgentCore Identity (P-1): `/conexiones/vuelta?session_id=…`.
 *
 * The `session_id` is read once, when the app starts, kept **only in memory** and removed from the
 * URL right away (`history.replaceState`), before anything renders: it never stays in the address
 * bar, the history, a Referer or Web Storage (P-9, TM-016). This page does not close the consent:
 * it hands the `session_id` to the tab that pressed «Conectar» (D100, consentChannel.ts).
 */

export type CapturedReturn =
  { kind: 'session'; sessionId: string } | { kind: 'failed'; result: 'denied' | 'error' };

let captured: CapturedReturn | null = null;

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

/**
 * What the start of the app captured, handed over once: the `session_id` leaves memory with it
 * (StrictMode runs effects twice; the second run gets null). Null when it did not come back from
 * the provider, or after a reload.
 */
export function takeConsentReturn(): CapturedReturn | null {
  const value = captured;
  captured = null;
  return value;
}

/** True when the app started on the return page (it renders on its own, without a session). */
export function isConsentReturnPage(pathname: string = window.location.pathname): boolean {
  return pathname === RETURN_PATH;
}

/** Tests only. */
export function resetConsentReturn(): void {
  captured = null;
}
