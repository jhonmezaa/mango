import { randomBytes } from 'node:crypto';

import type { Response, TestInfo } from '@playwright/test';
import { z } from 'zod';

import { deleteDisposable, type Deleted } from '../src/aws.ts';
import type { InstallConfig } from '../src/config.ts';
import { expect, leaves, note, test, type Session } from '../src/fixtures.ts';

// WITH EFFECT (`MANGO_INSTALL_EFFECTS=people`): a change of a person approved by a second
// administrator, and two administrators approving at the same time (`busy`), on a DISPOSABLE
// person this run invites and closes. Nobody else is touched.
//
// Leaves: the cards of the changes in «Cambios de personas» (30 days) and their events in
// Auditoría. The disposable person is deleted with the AWS CLI when there are credentials;
// without them it stays disabled and without groups, and the report says so.

const BUSY = 'Otro cambio de administradores está en curso. Inténtalo de nuevo en unos segundos.';
const ADMIN = 'mango-admin';
const ATTEMPTS = 3;

const invited = z.looseObject({ user_id: z.string() });
const proposed = z.looseObject({ result: z.string(), change_id: z.string().nullish() });
const people = z.looseObject({
  items: z.array(
    z.looseObject({
      user_id: z.string(),
      email: z.string(),
      status: z.string(),
      groups: z.array(z.string()),
    }),
  ),
});
const changes = z.looseObject({
  items: z.array(
    z.looseObject({
      change_id: z.string(),
      status: z.string(),
      target_user: z.string(),
      proposed_by: z.string(),
    }),
  ),
});

interface Person {
  email: string;
  userId: string;
}

async function stateOf(admin: Session, person: Person) {
  const answer = await admin.api('POST', '/api/admin/people/search', {
    prefix: person.email.split('@')[0],
  });
  expect(answer.status).toBe(200);
  return people.parse(answer.body).items.find((item) => item.user_id === person.userId) ?? null;
}

/** Proposes a change of the disposable person; returns its id when it waits for an approval. */
async function propose(by: Session, person: Person, action: string, body: object) {
  const answer = await by.api('POST', `/api/admin/people/${person.userId}/${action}`, body);
  expect(answer.status, `propose ${action}: ${answer.code ?? ''}`).toBe(200);
  const { result, change_id: id } = proposed.parse(answer.body);
  return result === 'proposed' && id ? id : null;
}

/** A change made effective: proposed by one administrator and, if it needs it, approved by the other. */
async function apply(by: Session, other: Session, person: Person, action: string, body: object) {
  const id = await propose(by, person, action, body);
  if (!id) return;
  const answer = await other.api('POST', `/api/admin/people/changes/${id}/approve`, {});
  expect(answer.status, `approve ${action}: ${answer.code ?? ''}`).toBe(200);
}

/** Ajustes › Personas read again, and the card of one change. */
async function cardOf(session: Session, changeId: string) {
  const { page } = session;
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Personas' }).click();
  await expect(page.getByRole('list', { name: 'Personas del directorio' })).toBeVisible();
  const card = page.getByRole('article').filter({ hasText: changeId.slice(0, 8) });
  await expect(card).toBeVisible();
  return card;
}

const approval = (session: Session, changeId: string): Promise<Response> =>
  session.page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/admin/people/changes/${changeId}/approve`,
  );

/**
 * Leaves the installation as it was: nothing pending, the person without groups, disabled and,
 * with AWS credentials, deleted. Every step is tried even if an earlier one failed.
 */
async function close(
  a: Session,
  b: Session,
  person: Person,
  config: InstallConfig,
  testInfo: TestInfo,
): Promise<void> {
  const reason = 'Cierre de la comprobación de la instalación.';
  const failures: string[] = [];
  const attempt = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch {
      failures.push(what);
    }
  };
  await attempt('settle the pending changes', async () => {
    const listed = changes.parse((await a.api('GET', '/api/admin/people/changes')).body);
    for (const change of listed.items) {
      if (change.target_user !== person.userId || change.status !== 'pending') continue;
      const [owner, other] = change.proposed_by === a.me.user_id ? [a, b] : [b, a];
      const base = `/api/admin/people/changes/${change.change_id}`;
      const withdrawn = await owner.api('POST', `${base}/withdraw`, {});
      if (withdrawn.status !== 200) await other.api('POST', `${base}/reject`, { reason });
    }
  });
  await attempt('remove the group', async () => {
    const now = await stateOf(a, person);
    if (!now?.groups.includes(ADMIN)) return;
    // The group of a disabled person cannot be removed: enabled first.
    if (now.status === 'disabled') await apply(a, b, person, 'enable', { reason });
    await apply(a, b, person, 'groups/remove', { group: ADMIN, reason });
  });
  await attempt('disable the person', async () => {
    const now = await stateOf(a, person);
    if (now && now.status !== 'disabled') await apply(a, b, person, 'disable', { reason });
  });
  const outcome: { deleted: Deleted } = { deleted: 'no-credentials' };
  await attempt('delete the person', async () => {
    const pool = z
      .looseObject({ region: z.string(), userPoolId: z.string() })
      .parse(await (await a.context.request.get('/config.json')).json());
    outcome.deleted = await deleteDisposable(config, pool, person);
  });
  const { deleted } = outcome;
  if (deleted === 'deleted') {
    leaves(
      testInfo,
      'La persona desechable se borró del directorio. Quedan sus tarjetas en «Cambios de personas» (30 días) y sus eventos en Auditoría.',
    );
  } else {
    const why =
      deleted === 'no-credentials'
        ? 'no hubo credenciales de AWS para borrarla'
        : 'la cuenta no pasó la comprobación previa al borrado';
    leaves(
      testInfo,
      `La persona desechable ${person.email} queda DESHABILITADA y sin grupos (${why}): bórrala en Cognito. Quedan sus tarjetas en «Cambios de personas» y sus eventos en Auditoría.`,
    );
    const now = await stateOf(a, person);
    expect(now?.groups ?? [], 'the disposable person ends without groups').toEqual([]);
    expect(now?.status ?? 'disabled', 'the disposable person ends disabled').toBe('disabled');
  }
  const pending = changes
    .parse((await a.api('GET', '/api/admin/people/changes')).body)
    .items.filter((c) => c.target_user === person.userId && c.status === 'pending');
  expect(pending, 'no change of the disposable person stays pending').toEqual([]);
  expect(failures, 'steps of the closing that failed').toEqual([]);
}

test('a change of a person needs a second administrator, and two at once answer busy', async ({
  as,
  config,
  needsEffect,
}, testInfo) => {
  needsEffect('people');
  test.skip(!config.people, 'la configuración no trae la sección «people»');
  if (!config.people) return;
  test.setTimeout(480_000);
  const a = await as('admin');
  const b = await as('secondAdmin');
  const tag = 'comprobación de la instalación';

  const email = `install-check-${randomBytes(4).toString('hex')}@${config.people.emailDomain}`;
  const invitation = await a.api('POST', '/api/admin/people/invitations', { email, groups: [] });
  expect(invitation.status, `invitation: ${invitation.code ?? ''}`).toBe(201);
  const person: Person = { email, userId: invited.parse(invitation.body).user_id };

  const gate = {
    holding: false,
    arrived: 0,
    open: (): undefined => undefined,
    wait: Promise.resolve(undefined),
  };
  try {
    await test.step('a sensitive group needs the approval of the other administrator', async () => {
      const id = await propose(a, person, 'groups', {
        group: ADMIN,
        reason: `Persona desechable (${tag}); se quita enseguida.`,
      });
      expect(id, `${ADMIN} waits for a second administrator`).toBeTruthy();
      if (!id) return;
      expect((await stateOf(a, person))?.groups).toEqual([]);
      // Who proposed it cannot approve it.
      const own = await a.api('POST', `/api/admin/people/changes/${id}/approve`, {});
      expect([own.status, own.code]).toEqual([403, 'same_approver']);

      const card = await cardOf(b, id);
      await expect(card).toContainText('Pendiente');
      const answered = approval(b, id);
      await card.getByRole('button', { name: 'Aprobar', exact: true }).click();
      expect((await answered).status()).toBe(200);
      await expect(card).toContainText('Aprobado');
      await expect.poll(async () => (await stateOf(a, person))?.groups).toEqual([ADMIN]);
    });

    await test.step('two changes of administrators approved at once: one applies, one is busy', async () => {
      for (const session of [a, b]) {
        await session.context.route('**/api/admin/people/changes/*/approve', async (route) => {
          if (gate.holding) {
            gate.arrived += 1;
            await gate.wait;
          }
          await route.continue().catch(() => undefined);
        });
      }
      let crossed = false;
      for (let attempt = 1; attempt <= ATTEMPTS && !crossed; attempt += 1) {
        const before = await stateOf(a, person);
        const reason = `Carrera de dos administradores, intento ${attempt} (${tag}).`;
        if (before?.status === 'disabled') await apply(a, b, person, 'enable', { reason });
        if (!before?.groups.includes(ADMIN)) {
          await apply(a, b, person, 'groups', { group: ADMIN, reason });
        }
        const remove = await propose(a, person, 'groups/remove', { group: ADMIN, reason });
        const disable = await propose(b, person, 'disable', { reason });
        expect(remove && disable, 'both changes wait for the other administrator').toBeTruthy();
        if (!remove || !disable) return;

        const [onB, onA] = await Promise.all([cardOf(b, remove), cardOf(a, disable)]);
        for (const session of [a, b]) {
          session.expect4xx({
            status: 409,
            path: /^\/api\/admin\/people\/changes\/[^/]+\/approve$/,
          });
        }
        gate.arrived = 0;
        gate.wait = new Promise<undefined>((resolve) => {
          gate.open = (): undefined => {
            resolve(undefined);
          };
        });
        gate.holding = true;
        const answers = Promise.all([approval(b, remove), approval(a, disable)]);
        await Promise.all([
          onB.getByRole('button', { name: 'Aprobar', exact: true }).click(),
          onA.getByRole('button', { name: 'Aprobar', exact: true }).click(),
        ]);
        // Both requests are held in their browsers; they leave in the same instant.
        await expect.poll(() => gate.arrived).toBe(2);
        gate.holding = false;
        gate.open();
        const [removed, disabled] = await answers;
        const statuses = [removed.status(), disabled.status()].sort();
        if (statuses[0] === 200 && statuses[1] === 200) continue; // one after the other
        expect(statuses, 'one applied and one refused').toEqual([200, 409]);
        const lost =
          removed.status() === 409
            ? { response: removed, session: b }
            : { response: disabled, session: a };
        const body = z
          .looseObject({ error: z.looseObject({ code: z.string() }) })
          .parse(await lost.response.json());
        expect(body.error.code).toBe('busy');
        await expect(lost.session.page.getByRole('alert').filter({ hasText: BUSY })).toBeVisible();
        crossed = true;
        note(
          testInfo,
          `busy: las dos aprobaciones se cruzaron en el intento ${attempt}; se aplicó «${removed.status() === 200 ? 'quitar mango-admin' : 'deshabilitar'}» y la otra respondió 409 busy.`,
        );
      }
      if (!crossed) {
        note(
          testInfo,
          `busy: en ${ATTEMPTS} intentos las dos aprobaciones se aplicaron una tras otra; la respuesta busy no se llegó a ver en esta corrida.`,
        );
      }
    });
  } finally {
    gate.holding = false;
    gate.open();
    for (const session of [a, b]) {
      await session.context.unrouteAll({ behavior: 'ignoreErrors' });
    }
    await close(a, b, person, config, testInfo);
  }
});
