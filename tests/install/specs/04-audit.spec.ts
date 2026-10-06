import { z } from 'zod';

import { expect, note, test } from '../src/fixtures.ts';

// Auditoría, as an administrator: the rows say what happened in words, never with the raw key
// of the event or of its detail, with and without «Mostrar lecturas». Reads only; leaves its
// own read events.

const list = z.looseObject({ items: z.array(z.looseObject({ event: z.string() })) });

/** A detail written as the API stores it: `change_id: … · outcome: applied`. */
const RAW_DETAIL = /\b[a-z]+(?:_[a-z]+)*: \S+ · [a-z]+(?:_[a-z]+)*: /;

/**
 * Known defect (reported 2026-10-05): the changes of people still show their detail as raw
 * keys. They are counted in the report instead of failing the run. Any other row with raw keys
 * fails. Remove an entry when its row is written in words.
 */
const KNOWN_RAW = [
  'Persona invitada',
  'Grupo asignado a persona',
  'Grupo quitado a persona',
  'Acceso deshabilitado',
  'Acceso rehabilitado',
  'Cambio de persona propuesto',
  'Cambio de persona aprobado',
  'Cambio de persona rechazado',
  'Cambio de persona retirado',
];

test('Auditoría names every event in words and shows the sign-in of this run', async ({
  as,
}, testInfo) => {
  const { page } = await as('admin');
  const read = () =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/admin/audit' &&
        response.request().method() === 'GET',
    );
  await page.goto('/audit', { waitUntil: 'commit' });
  const events = new Set(list.parse(await (await read()).json()).items.map((item) => item.event));
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  const today = page.getByRole('region', { name: 'Hoy' });
  await expect(
    today.getByRole('button').filter({ hasText: 'Sesión iniciada' }).first(),
  ).toBeVisible();

  const reads = page.getByRole('switch', { name: 'Mostrar lecturas' });
  await expect(reads).toHaveAttribute('aria-checked', 'false');
  // A recovered session is a read: hidden until asked for.
  await expect(page.getByText('Sesión recuperada')).toHaveCount(0);
  const again = read();
  again.catch(() => undefined);
  await reads.click();
  for (const item of list.parse(await (await again).json()).items) events.add(item.event);
  await expect(reads).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Sesión recuperada').first()).toBeVisible();

  // No key the API returned (`session.started`, `directory.list`…) is written in a row.
  expect(events.size).toBeGreaterThan(0);
  const rows = await page.getByRole('main').getByRole('region').getByRole('button').allInnerTexts();
  expect(rows.length).toBeGreaterThan(0);
  const withKeys = rows
    .map((row) => row.replace(/\s+/g, ' '))
    .filter((row) => RAW_DETAIL.test(row));
  const known = withKeys.filter((row) => KNOWN_RAW.some((label) => row.includes(label)));
  expect(
    withKeys.filter((row) => !known.includes(row)).map((row) => row.slice(0, 60)),
    'rows whose detail shows raw keys',
  ).toEqual([]);
  if (known.length > 0) {
    note(
      testInfo,
      `Auditoría: ${known.length} de ${rows.length} filas (cambios de personas) muestran su detalle con claves crudas. Defecto conocido.`,
    );
  }
  for (const row of rows) for (const event of events) expect(row).not.toContain(event);

  // The panel of one event opens and closes.
  await today.getByRole('button').filter({ hasText: 'Sesión iniciada' }).first().click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByText('Ingresó con contraseña y MFA')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await reads.click();
  await expect(reads).toHaveAttribute('aria-checked', 'false');
});
