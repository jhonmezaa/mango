/** MFA resets (D20): the mock admin can propose and withdraw; approving needs another admin. */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { auditedWrite } from './audit.ts';
import { MOCK_USER } from './cognito.ts';
import { readObject, sendError, sendJson } from './http.ts';

const MFA_RESET_TTL_MS = 72 * 3_600_000;
const mfaResets: Record<string, unknown>[] = [];

function mfaResetsView() {
  const now = Date.now();
  return {
    items: mfaResets.map((item) =>
      item.status === 'pending' && Date.parse(String(item.expires_at)) <= now
        ? { ...item, status: 'expired' }
        : item,
    ),
  };
}

export async function handleMfaResets(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  if (path === '/admin/mfa-resets' && req.method === 'GET') {
    sendJson(res, 200, mfaResetsView());
    return true;
  }
  if (path === '/admin/mfa-resets' && req.method === 'POST') {
    const body = await readObject(req, ['email', 'reason', 'identity_verified']);
    const email = typeof body?.email === 'string' ? body.email : '';
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!body || body.identity_verified !== true || !/^[^@\s]+@[^@\s]+$/.test(email) || !reason) {
      sendError(res, 422, 'invalid_request', 'Invalid MFA reset request');
      return true;
    }
    if (email === MOCK_USER) {
      sendError(res, 403, 'self_reset', 'you cannot reset your own MFA');
      return true;
    }
    if (mfaResetsView().items.some((i) => i.status === 'pending' && i.target_email === email)) {
      sendError(res, 409, 'already_pending', 'there is already an open request for this user');
      return true;
    }
    const now = Date.now();
    const item = {
      change_id: randomBytes(16).toString('hex'),
      status: 'pending',
      target_user: `sub-${email}`,
      target_email: email,
      proposed_by: MOCK_USER,
      proposed_by_email: MOCK_USER,
      reason,
      identity_verified: true,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + MFA_RESET_TTL_MS).toISOString(),
      decided_by: null,
      decided_by_email: null,
      decided_at: null,
      note: null,
    };
    auditedWrite(
      'account.mfa_reset_propose',
      { change_id: item.change_id, identity_verified: true },
      () => {
        mfaResets.unshift(item);
      },
    );
    sendJson(res, 201, { change_id: item.change_id });
    return true;
  }
  const match = /^\/admin\/mfa-resets\/([0-9a-f]{32})\/(approve|reject|withdraw)$/.exec(path);
  if (!match || req.method !== 'POST') return false;
  const item = mfaResets.find((i) => i.change_id === match[1]);
  if (!item) {
    sendError(res, 404, 'not_found', 'request not found');
    return true;
  }
  if (match[2] !== 'withdraw') {
    // Every request in the mock is the mock admin's own: another admin must decide.
    sendError(res, 403, 'same_approver', 'another admin must decide');
    return true;
  }
  if (item.status !== 'pending') {
    sendError(res, 409, 'version_conflict', 'the request is already closed');
    return true;
  }
  auditedWrite('account.mfa_reset_withdraw', { change_id: item.change_id }, () => {
    Object.assign(item, {
      status: 'withdrawn',
      decided_by: MOCK_USER,
      decided_by_email: MOCK_USER,
      decided_at: new Date().toISOString(),
    });
  });
  sendJson(res, 200, mfaResetsView());
  return true;
}
