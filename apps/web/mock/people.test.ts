import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  zActionOutSchema,
  zChangeListOutSchema,
  zInstallationOutSchema,
  zInvitedOutSchema,
  zPeopleOutSchema,
} from '@mango/api-client/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleAudit } from './audit.ts';
import { MOCK_USER } from './cognito.ts';
import { handlePeople } from './people.ts';

let server: Server;
let origin = '';

async function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${origin}${path}`, init);
  const answer: unknown = await response.json();
  return { status: response.status, body: answer };
}

const errorCode = (body: unknown) => (body as { error?: { code?: string } }).error?.code;
const search = async (body: object = {}) =>
  zPeopleOutSchema.parse((await call('POST', '/admin/people/search', body)).body);
const changes = async () =>
  zChangeListOutSchema.parse((await call('GET', '/admin/people/changes')).body);

/** `session.ended` events of the mock's audit log, newest first: who and why. */
async function endedSessions() {
  const { body } = await call('GET', '/admin/audit?event=session.ended');
  const { items } = body as { items: { actor_email: string; detail: { reason: string } }[] };
  return items.map((item) => [item.actor_email, item.detail.reason]);
}

async function personByEmail(email: string) {
  const found = (await search({ prefix: email })).items[0];
  if (!found) throw new Error(`seed changed: ${email}`);
  return found;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void (async () =>
      (await handlePeople(req, res, url.pathname, url)) ||
      (await handleAudit(req, res, url.pathname, url)))().then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('mock people', () => {
  it('answers the directory with the generated contract, people without access first', async () => {
    const first = await search();
    expect(first.items).toHaveLength(20);
    expect(first.next_cursor).toBe('20');
    expect(first.admins).toBe(3);
    expect(first.pending).toBeGreaterThan(0);
    // Signed up without a group: before everyone else.
    expect(first.items[0]).toMatchObject({ status: 'active', groups: [] });
    expect(first.items.every((item) => /@(empresa|example)\.com$/.test(item.email))).toBe(true);
    const next = await search({ cursor: first.next_cursor });
    expect(next.items[0]?.email).not.toBe(first.items[0]?.email);
    const waiting = await search({ filter: 'pending' });
    expect(waiting.items).toHaveLength(first.pending);
    expect((await search({ prefix: 'USUARIO1@' })).items.map((item) => item.email)).toEqual([
      'usuario1@empresa.com',
    ]);
    expect((await search({ filter: 'disabled' })).items.every((i) => i.status === 'disabled')).toBe(
      true,
    );
  });

  it('refuses what the contract refuses', async () => {
    for (const body of [{ prefix: 'a"b' }, { filter: 'admins' }, { cursor: 'x' }, { extra: 1 }]) {
      const refused = await call('POST', '/admin/people/search', body);
      expect(refused.status).toBe(422);
    }
    const unknown = await call(
      'POST',
      '/admin/people/00000000-0000-4000-8000-999999999999/disable',
      { reason: 'x' },
    );
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown.body)).toBe('user_not_found');
  });

  it('applies a normal group at once and proposes a sensitive one', async () => {
    const target = await personByEmail('usuario4@empresa.com');
    const path = `/admin/people/${target.user_id}/groups`;
    const applied = await call('POST', path, { group: 'seguridad' });
    expect(zActionOutSchema.parse(applied.body).result).toBe('applied');
    expect((await personByEmail(target.email)).groups).toContain('seguridad');
    expect(errorCode((await call('POST', path, { group: 'seguridad' })).body)).toBe(
      'already_member',
    );
    expect(errorCode((await call('POST', path, { group: 'no-existe' })).body)).toBe(
      'unknown_group',
    );

    expect(errorCode((await call('POST', path, { group: 'mango-admin' })).body)).toBe(
      'reason_required',
    );
    const proposed = zActionOutSchema.parse(
      (await call('POST', path, { group: 'mango-admin', reason: 'Cubre aprobaciones' })).body,
    );
    expect(proposed.result).toBe('proposed');
    expect((await personByEmail(target.email)).groups).not.toContain('mango-admin');
    expect(errorCode((await call('POST', path, { group: 'mango-admin', reason: 'x' })).body)).toBe(
      'already_pending',
    );
    // Who proposed cannot approve; they withdraw.
    const own = (await changes()).items.find((item) => item.change_id === proposed.change_id);
    expect(own).toMatchObject({ status: 'pending', proposed_by: MOCK_USER, kind: 'add' });
    const base = `/admin/people/changes/${String(proposed.change_id)}`;
    expect(errorCode((await call('POST', `${base}/approve`, {})).body)).toBe('same_approver');
    const withdrawn = zChangeListOutSchema.parse((await call('POST', `${base}/withdraw`, {})).body);
    expect(withdrawn.items.find((item) => item.change_id === proposed.change_id)?.status).toBe(
      'withdrawn',
    );
    expect((await call('POST', `${base}/withdraw`, {})).status).toBe(409);

    const removed = await call('POST', `${path}/remove`, { group: 'seguridad' });
    expect(zActionOutSchema.parse(removed.body).result).toBe('applied');
    expect(errorCode((await call('POST', `${path}/remove`, { group: 'seguridad' })).body)).toBe(
      'not_member',
    );
  });

  it('says which change is about someone who is no longer in the directory', async () => {
    const { items } = await changes();
    expect(items.filter((item) => !item.target_in_directory).map((item) => item.status)).toEqual([
      'rejected',
    ]);
    expect(items.filter((item) => item.target_in_directory).length).toBeGreaterThan(1);
  });

  it('decides what another administrator proposed, and not an expired change', async () => {
    const { items } = await changes();
    const open = items.find((item) => item.status === 'pending' && item.kind === 'add');
    const expired = items.find((item) => item.status === 'expired');
    if (!open || !expired) throw new Error('seed changed');
    expect((await call('POST', `/admin/people/changes/${open.change_id}/reject`, {})).status).toBe(
      422,
    );
    const approved = zChangeListOutSchema.parse(
      (await call('POST', `/admin/people/changes/${open.change_id}/approve`, {})).body,
    );
    expect(approved.items.find((item) => item.change_id === open.change_id)).toMatchObject({
      status: 'approved',
      decided_by: MOCK_USER,
    });
    expect((await personByEmail(open.target_email)).groups).toContain('mango-admin');
    expect((await search()).admins).toBe(4);
    const late = await call('POST', `/admin/people/changes/${expired.change_id}/approve`, {});
    expect(late.status).toBe(410);
    expect(errorCode(late.body)).toBe('expired');
  });

  it('disables and re-enables, with a second administrator where the API asks for one', async () => {
    const plain = await personByEmail('usuario10@empresa.com');
    const base = `/admin/people/${plain.user_id}`;
    expect(errorCode((await call('POST', `${base}/disable`, {})).body)).toBe('invalid_request');
    expect(
      zActionOutSchema.parse((await call('POST', `${base}/disable`, { reason: 'Salió' })).body)
        .result,
    ).toBe('applied');
    expect((await personByEmail(plain.email)).status).toBe('disabled');
    // Their session ends, and the event names the person and the cause like the API does.
    expect((await endedSessions())[0]).toEqual([plain.email, 'disabled']);
    expect(errorCode((await call('POST', `${base}/groups`, { group: 'seguridad' })).body)).toBe(
      'user_disabled',
    );
    expect(zActionOutSchema.parse((await call('POST', `${base}/enable`, {})).body).result).toBe(
      'applied',
    );

    // An administrator is disabled by two; someone with a sensitive group is re-enabled by two.
    const admin = await personByEmail('usuario6@empresa.com');
    expect(
      zActionOutSchema.parse(
        (await call('POST', `/admin/people/${admin.user_id}/disable`, { reason: 'Rota' })).body,
      ).result,
    ).toBe('proposed');
    const central = await personByEmail('usuario17@empresa.com');
    const enable = `/admin/people/${central.user_id}/enable`;
    expect(errorCode((await call('POST', enable, {})).body)).toBe('reason_required');
    expect(
      zActionOutSchema.parse((await call('POST', enable, { reason: 'Volvió' })).body).result,
    ).toBe('proposed');
    expect((await personByEmail(central.email)).status).toBe('disabled');

    const own = await personByEmail(MOCK_USER);
    const self = await call('POST', `/admin/people/${own.user_id}/disable`, { reason: 'x' });
    expect(self.status).toBe(403);
    expect(errorCode(self.body)).toBe('self_change');
    const ownGroup = await call('POST', `/admin/people/${own.user_id}/groups/remove`, {
      group: 'mango-admin',
      reason: 'x',
    });
    expect(errorCode(ownGroup.body)).toBe('self_change');
  });

  it('invites any company domain, never a public one, without sensitive groups', async () => {
    const invite = (body: object) => call('POST', '/admin/people/invitations', body);
    expect(errorCode((await invite({ email: 'ana@gmail.com' })).body)).toBe('public_domain');
    expect(errorCode((await invite({ email: 'ana@outlook.es' })).body)).toBe('public_domain');
    expect((await invite({ email: 'ana@otra.com' })).status).toBe(201);
    expect(errorCode((await invite({ email: 'sin arroba' })).body)).toBe('invalid_email');
    expect(
      errorCode((await invite({ email: 'ana@example.com', groups: ['mango-admin'] })).body),
    ).toBe('sensitive_group');
    const created = await invite({ email: ' Ana@Example.com ', groups: ['seguridad'] });
    expect(created.status).toBe(201);
    expect(zInvitedOutSchema.parse(created.body).result).toBe('applied');
    expect(await personByEmail('ana@example.com')).toMatchObject({
      status: 'invited',
      mfa: false,
      groups: ['seguridad'],
    });
    const again = await invite({ email: 'ana@example.com' });
    expect(again.status).toBe(409);
    expect(errorCode(again.body)).toBe('already_exists');
  });

  it('answers the installation with the generated contract and nothing real', async () => {
    const installation = zInstallationOutSchema.parse(
      (await call('GET', '/admin/installation')).body,
    );
    expect(installation.version).toBe('0.1.0');
    expect(installation.release).toBe('v0.1.0-g1a2b3c4');
    expect(installation.sign_up_domains).toEqual(['example.com', 'empresa.com']);
    expect(installation.management_account_id).toBe('111111111111');
  });
});
