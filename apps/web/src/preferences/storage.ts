/**
 * The only module allowed to touch localStorage. It stores UI preferences (theme, sidebar state, pinned agents, Marketplace layout),
 * never tokens, session data or anything used for authorization (REACT-AUTH-001, JS-STORAGE-001).
 *
 * Web Storage can be missing or throw (private mode, blocked site data, quota), and its content is
 * attacker-influenceable: every access is wrapped in try/catch and callers validate the values.
 */
export type PreferenceKey =
  | 'mango-theme'
  | 'mango-sb-collapsed'
  | 'mango-sb-groups'
  | 'mango-pinned-agents'
  | 'mango-mk-layout'
  /**
   * '1' while this browser had a session (design round 27, «Recargar la página»): it only picks
   * what a page load paints first (skeletons or the neutral cover) and whether the sign-in says
   * the session ended. It never decides authorization; the session cookie does (AGENTS.md).
   */
  | 'mango-had-session';

function preferenceStore(): Storage | null {
  try {
    // eslint-disable-next-line no-restricted-properties -- UI preferences only, see module doc.
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readPreference(key: PreferenceKey): string | null {
  try {
    return preferenceStore()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function removePreference(key: PreferenceKey): void {
  try {
    preferenceStore()?.removeItem(key);
  } catch {
    // Nothing to do: a stale hint only changes what a page load paints first.
  }
}

export function writePreference(key: PreferenceKey, value: string): void {
  try {
    preferenceStore()?.setItem(key, value);
  } catch {
    // Not persisted; the in-memory state still applies for this page load.
  }
}
