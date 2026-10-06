import { z } from 'zod';

import { ROLES } from '../src/config.ts';
import { expect, note, test } from '../src/fixtures.ts';

// Last journey: the run leaves no session open. Every «Sesión iniciada» of the test users
// since the run began has its «Sesión cerrada», except the sessions this worker still holds
// (closed when it ends). Reads only.

const page = z.looseObject({
  items: z.array(z.looseObject({ event: z.string(), actor_email: z.string().nullable() })),
  next_cursor: z.string().nullable(),
});

test('every session the run opened was closed', async ({ as, config, openRoles }, testInfo) => {
  const admin = await as('admin');
  const ours = new Set(ROLES.flatMap((role) => config.users[role]?.email ?? []));
  const count = async () => {
    let started = 0;
    let ended = 0;
    let cursor: string | null = null;
    for (let read = 0; read < 20; read += 1) {
      const query = new URLSearchParams({
        event: 'session.',
        since: config.startedAt,
        limit: '100',
      });
      if (cursor) query.set('cursor', cursor);
      const answer = await admin.api('GET', `/api/admin/audit?${query.toString()}`);
      expect(answer.status).toBe(200);
      const { items, next_cursor: next } = page.parse(answer.body);
      for (const item of items) {
        if (!item.actor_email || !ours.has(item.actor_email)) continue;
        if (item.event === 'session.started') started += 1;
        if (item.event === 'session.ended') ended += 1;
      }
      cursor = next;
      if (!cursor) break;
    }
    return { started, ended, open: started - ended };
  };
  // The trail is written right after each call; a moment may pass until it can be read.
  await expect.poll(async () => (await count()).open).toBe(openRoles().length);
  const { started, ended } = await count();
  note(
    testInfo,
    `sesiones de los usuarios de prueba en esta corrida: ${started} iniciadas, ${ended} cerradas; las ${started - ended} restantes las cierra la suite al terminar.`,
  );
});
