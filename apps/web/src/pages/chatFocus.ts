/**
 * «Abrir en el mensaje de la coincidencia» (design round 35, D103): Buscar conversaciones opens a
 * conversation at a message. The message id travels in the router's navigation state, never in
 * the URL, so it stays out of the address bar, the history entries' URLs and access logs (owner's
 * choice). History state is untrusted input: only a well-formed id is used.
 */
export interface ChatFocusState {
  focusMessage: string;
}

const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function chatFocusState(messageId: string | null): ChatFocusState | undefined {
  return messageId !== null && MESSAGE_ID.test(messageId) ? { focusMessage: messageId } : undefined;
}

export function focusMessageFrom(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('focusMessage' in state)) return null;
  const id = state.focusMessage;
  return typeof id === 'string' && MESSAGE_ID.test(id) ? id : null;
}

/** Design chat.jsx: the message sits this far below the top edge of the conversation. */
export const FOCUS_TOP_PX = 96;
/** Design styles.css `.ch-hl`: the highlight stays 2 s, then fades in 0.9 s (CSS). */
export const FOCUS_HIGHLIGHT_MS = 2000;
