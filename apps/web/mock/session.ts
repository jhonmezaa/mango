/**
 * Mock of the session cookie of mango-api (D63), for the dev server only: same routes, same
 * cookie attributes and the same CSRF guard, so the SPA runs its real flow (a reload keeps the
 * session). Sessions live in the dev server's memory; the real API keeps no token (the
 * refresh token travels encrypted in the cookie).
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { recordAudit } from './audit.ts';
import { renewFromRefreshToken, revokeRefreshToken, sessionOf } from './cognito.ts';
import { originOf, readBody, sendError, sendJson } from './http.ts';

const COOKIE = '__Host-mango_session';
const SESSION_SECONDS = 8 * 3600;
const sessions = new Map<string, { refreshToken: string; federated: boolean }>();

function cookieOf(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, value] = part.trim().split('=', 2);
    if (name === COOKIE && value) return value;
  }
  return null;
}

function setCookie(res: ServerResponse, value: string, maxAge: number): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${value}; HttpOnly; Max-Age=${String(maxAge)}; Path=/; SameSite=strict; Secure`,
  );
}

function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  return (
    req.headers['x-mango-session'] === '1' &&
    req.headers.origin === originOf(req) &&
    (site === undefined || site === 'same-origin')
  );
}

/** `path` has no `/api` prefix. Returns false when the route is not a session route. */
export async function handleSession(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  if (path !== '/session' && path !== '/session/refresh') return false;
  res.setHeader('Cache-Control', 'no-store');
  if (!sameOrigin(req)) {
    sendError(res, 403, 'forbidden', 'not allowed');
    return true;
  }
  const sid = cookieOf(req);

  if (path === '/session' && req.method === 'POST') {
    if (sessionOf(req) === null) {
      sendError(res, 401, 'unauthenticated', 'missing bearer token');
      return true;
    }
    const body = JSON.parse(await readBody(req)) as {
      refresh_token?: unknown;
      federated?: unknown;
    };
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
    if (!renewFromRefreshToken(originOf(req), refreshToken)) {
      sendError(res, 401, 'unauthenticated', 'invalid token');
      return true;
    }
    if (sid) sessions.delete(sid);
    const next = randomBytes(32).toString('base64url');
    sessions.set(next, { refreshToken, federated: body.federated === true });
    recordAudit('session.started', { federated: body.federated === true });
    setCookie(res, next, SESSION_SECONDS);
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (path === '/session/refresh' && req.method === 'POST') {
    const session = sid ? sessions.get(sid) : undefined;
    const renewed = session ? renewFromRefreshToken(originOf(req), session.refreshToken) : null;
    if (!session || !renewed) {
      if (sid) sessions.delete(sid);
      // Not an error: every first visit asks.
      setCookie(res, '', 0);
      res.statusCode = 204;
      res.end();
      return true;
    }
    recordAudit('session.renewed', {});
    sendJson(res, 200, { ...renewed, federated: session.federated });
    return true;
  }

  if (path === '/session' && req.method === 'DELETE') {
    const session = sid ? sessions.get(sid) : undefined;
    if (sid && session) {
      revokeRefreshToken(session.refreshToken);
      sessions.delete(sid);
      recordAudit('session.ended', { reason: 'sign_out' });
    }
    setCookie(res, '', 0);
    res.statusCode = 204;
    res.end();
    return true;
  }

  sendError(res, 405, 'method_not_allowed', 'Method not allowed');
  return true;
}
