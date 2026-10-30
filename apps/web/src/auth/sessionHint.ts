import { readPreference, removePreference, writePreference } from '../preferences/storage';

/**
 * Whether this browser had a session (design round 27, «Recargar la página»). A UI hint only: it
 * picks what a page load paints first (skeletons or the neutral cover) and whether the sign-in
 * says the session ended. It holds nothing about the session and never decides authorization;
 * the session cookie does (AGENTS.md, REACT-AUTH-001).
 */
const HAD_SESSION = 'mango-had-session';

export function hadSession(): boolean {
  return readPreference(HAD_SESSION) === '1';
}

export function rememberSession(had: boolean): void {
  if (had) writePreference(HAD_SESSION, '1');
  else removePreference(HAD_SESSION);
}
