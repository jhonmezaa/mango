import { z } from 'zod';

import { ROLES, type Role } from '../src/config.ts';
import { expect, test, type Session } from '../src/fixtures.ts';

// What each role sees: the administration screens, the Marketplace and the Org Chart, compared
// with what the API answers to that same person (`/api/me`, `/api/agents`, `/api/agents/org`).
// Reads only. Leaves the read events of each screen in Auditoría.

const agents = z.looseObject({
  items: z.array(
    z.looseObject({ id: z.string(), name: z.string(), retired_at: z.string().nullable() }),
  ),
});
const org = z.looseObject({
  nodes: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      role: z.string(),
      can_use: z.boolean(),
      can_edit: z.boolean(),
      groups: z.array(z.string()),
    }),
  ),
});

/** Opens a screen and returns the answer of the API call that fills it. */
async function openWith(session: Session, path: string, apiPath: string): Promise<unknown> {
  // After the new document commits: a call of the page being left would match too, and its
  // body is gone with that page.
  await session.page.goto(path, { waitUntil: 'commit' });
  const response = await session.page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === apiPath && candidate.request().method() === 'GET',
  );
  expect(response.status()).toBe(200);
  return response.json();
}

for (const role of ROLES satisfies readonly Role[]) {
  test.describe(`as ${role}`, () => {
    test('the administration screens follow the role, in the screen and in the API', async ({
      as,
    }) => {
      const session = await as(role);
      const { page, me } = session;
      const admin = await session.api('GET', '/api/admin/installation');
      const audit = await session.api('GET', '/api/admin/audit?limit=1');
      const people = await session.api('POST', '/api/admin/people/search', {});
      expect([admin.status, audit.status, people.status]).toEqual(
        me.is_admin ? [200, 200, 200] : [403, 403, 403],
      );

      for (const [path, title] of [
        ['/settings', 'Ajustes'],
        ['/audit', 'Audit log'],
        ['/budgets', 'Presupuestos'],
      ] as const) {
        // Whoever is not an administrator may still make the screen ask, and be refused.
        if (!me.is_admin) session.expect4xx({ status: 403, path: /^\/api\/admin\// });
        await page.goto(path);
        if (me.is_admin) {
          await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
        } else {
          await expect(page.getByText('No tienes acceso a esta sección')).toBeVisible();
          await expect(page.getByRole('heading', { level: 1, name: title })).toHaveCount(0);
        }
      }
      const nav = page.getByRole('navigation', { name: 'Navegación principal' });
      await expect(nav.getByRole('link', { name: 'Marketplace', exact: true })).toBeVisible();
      // «Ajustes» is offered only to administrators (the API decides; this is what is shown).
      await expect(page.getByRole('button', { name: 'Ajustes', exact: true })).toHaveCount(
        me.is_admin ? 1 : 0,
      );
    });

    test('Marketplace and Org Chart show what the API lets this person use and edit', async ({
      as,
    }) => {
      const session = await as(role);
      const { page, me } = session;

      const listed = agents.parse(await openWith(session, '/marketplace', '/api/agents'));
      const active = listed.items.filter((agent) => agent.retired_at === null);
      for (const agent of active) {
        await expect(
          page.getByRole('button', { name: `Ver detalle de ${agent.name}`, exact: true }).first(),
        ).toBeVisible();
      }
      await expect(page.getByRole('button', { name: /^Ver detalle de / })).toHaveCount(
        active.length,
      );

      const raw = await openWith(session, '/org', '/api/agents/org');
      const tree = org.parse(raw);
      // The tree names agents and groups, never a person.
      expect(JSON.stringify(raw)).not.toContain('@');
      // The Marketplace lists exactly the agents of the tree this person can use.
      expect(
        tree.nodes
          .filter((node) => node.can_use)
          .map((node) => node.id)
          .sort(),
      ).toEqual(active.map((agent) => agent.id).sort());
      if (me.is_admin) expect(tree.nodes.every((node) => node.can_edit)).toBe(true);
      if (!me.is_admin && !me.can.create_agent) {
        expect(tree.nodes.some((node) => node.can_edit)).toBe(false);
      }
      for (const node of tree.nodes) {
        // Who can use an agent is told nothing about its groups.
        expect(node.can_use ? node.groups : ['-']).not.toEqual(node.can_use ? ['-'] : []);
      }

      for (const node of tree.nodes.slice(0, 6)) {
        await page
          .getByRole('button', { name: `${node.name}, ${node.role}`, exact: true })
          .first()
          .click();
        const panel = page.getByRole('complementary', { name: `Detalle de ${node.name}` });
        await expect(panel).toBeVisible();
        await expect(panel.getByRole('link', { name: 'Editar', exact: true })).toHaveCount(
          node.can_edit ? 1 : 0,
        );
        await expect(panel.getByText('No puedes usar este agente')).toHaveCount(
          node.can_use ? 0 : 1,
        );
        await expect(panel.getByRole('link', { name: 'Ver en Marketplace' })).toHaveCount(
          node.can_use ? 1 : 0,
        );
        await expect(panel).not.toContainText('@');
      }
    });
  });
}
