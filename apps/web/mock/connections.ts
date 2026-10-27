/**
 * Mock routes of «Mis conexiones» and the return (docs/specs/poc-api-contract.md, «MCP remotos de
 * terceros: Mis conexiones y la vuelta»): GET /me/connections, connect, disconnect and POST
 * /oauth/callback. The mock user's groups are the ones of GET /me.
 *
 * Differences with the API, on purpose: there is no Gateway or Identity. «Conectar» hands a
 * placeholder AgentCore URL (in the e2e test, the browser is sent from it to the return route) and
 * the return accepts any well-formed `session_id`, except one that says `notyours` or `expired`.
 */
import { randomBytes } from 'node:crypto';

import { readBody, sendError, sendJson, type ApiHandler } from './http.ts';
import { REMOTE_PROFILE, usableRemotes } from './remoteMcp.ts';

/** The mock user's groups (GET /me). */
export const MOCK_GROUPS = ['finops-central', 'mango-admin'];
const CONSENT_TTL_MS = 10 * 60_000;
const ROUTE = /^\/me\/connections\/([a-z2-7]{12})\/(connect|disconnect)$/;
const SESSION_URI = /^urn:ietf:params:oauth:request_uri:[A-Za-z0-9._~-]{1,990}$/;

const connected = new Map<string, string>();
/** The pending consent of the mock user: one, the latest (as the interceptor keeps it). */
let pending: { registration: string; expires: number } | null = null;

function connectionOf(remote: ReturnType<typeof usableRemotes>[number]) {
  const at = connected.get(remote.id) ?? null;
  return {
    registration_id: remote.id,
    profile_id: REMOTE_PROFILE.id,
    service: REMOTE_PROFILE.name,
    provider: REMOTE_PROFILE.provider,
    organization: remote.organization,
    link_hosts: REMOTE_PROFILE.link_hosts,
    status:
      remote.status === 'disabled'
        ? 'disabled'
        : remote.secretExpired
          ? 'secret_expired'
          : at
            ? 'connected'
            : 'not_connected',
    connected_at: at,
  };
}

/** The chat and the Playground: is the mock user connected to this registration? */
export function isConnected(registration: string): boolean {
  return connected.has(registration);
}

/** The first active registration of the mock user, for the chat's remote turn. */
export function firstUsableRemote() {
  return usableRemotes(MOCK_GROUPS).find((remote) => remote.status === 'active') ?? null;
}

/** A remote tool answered `consent_required`: the interceptor kept a pending consent. */
export function markConsentPending(registration: string): void {
  pending = { registration, expires: Date.now() + CONSENT_TTL_MS };
}

export const handleConnections: ApiHandler = async (req, res, path) => {
  if (path === '/me/connections' && req.method === 'GET') {
    sendJson(res, 200, { connections: usableRemotes(MOCK_GROUPS).map(connectionOf) });
    return true;
  }
  if (path === '/oauth/callback' && req.method === 'POST') {
    let sessionId: unknown;
    try {
      sessionId = (JSON.parse(await readBody(req)) as { session_id?: unknown }).session_id;
    } catch {
      sessionId = null;
    }
    if (typeof sessionId !== 'string' || !SESSION_URI.test(sessionId)) {
      sendError(res, 422, 'validation_failed', 'invalid session id');
      return true;
    }
    if (!pending || pending.expires < Date.now() || sessionId.includes('expired')) {
      sendError(res, 410, 'consent_expired', 'consent expired');
      return true;
    }
    if (sessionId.includes('notyours')) {
      sendError(res, 403, 'consent_not_yours', 'not yours');
      return true;
    }
    const registration = pending.registration;
    pending = null;
    connected.set(registration, new Date().toISOString());
    sendJson(res, 200, {
      status: 'connected',
      registration_id: registration,
      profile_id: REMOTE_PROFILE.id,
    });
    return true;
  }
  const match = ROUTE.exec(path);
  if (!match || req.method !== 'POST') return false;
  const [, registration = '', action] = match;
  const remote = usableRemotes(MOCK_GROUPS).find((item) => item.id === registration);
  if (!remote) {
    sendError(res, 404, 'not_found', 'not found');
    return true;
  }
  if (action === 'disconnect') {
    connected.delete(registration);
    sendJson(res, 200, connectionOf(remote));
    return true;
  }
  if (remote.status !== 'active') {
    sendError(res, 409, 'remote_disabled', 'disabled');
    return true;
  }
  if (remote.secretExpired) {
    sendError(res, 409, 'secret_expired', 'secret expired');
    return true;
  }
  if (connected.has(registration)) {
    sendJson(res, 200, { status: 'already_connected' });
    return true;
  }
  markConsentPending(registration);
  const requestUri = encodeURIComponent(
    `urn:ietf:params:oauth:request_uri:mock-${randomBytes(8).toString('hex')}`,
  );
  sendJson(res, 200, {
    status: 'consent_required',
    // Placeholder of the AgentCore authorization URL (D94 (2)).
    authorization_url: `https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/authorize?request_uri=${requestUri}`,
    expires_at: new Date(Date.now() + CONSENT_TTL_MS).toISOString(),
  });
  return true;
};
