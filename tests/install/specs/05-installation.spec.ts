import { z } from 'zod';

import { expect, note, test } from '../src/fixtures.ts';

// Ajustes › General › Instalación shows the release that was deployed. Reads only.

const installation = z.looseObject({
  release: z.string().nullable(),
  version: z.string().nullable(),
});

test('Ajustes › Instalación shows the installed release', async ({ as, config }, testInfo) => {
  const { page } = await as('admin');
  await page.goto('/settings', { waitUntil: 'commit' });
  const answered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/admin/installation',
  );
  const { release, version } = installation.parse(await (await answered).json());
  expect(release, 'the installation reports its release label').toBeTruthy();
  note(testInfo, `release: ${release ?? '-'}`);

  const section = page.getByRole('tabpanel', { name: 'General' });
  await expect(section.getByRole('heading', { level: 2, name: 'Instalación' })).toBeVisible();
  await expect(section.getByText('Publicación', { exact: false }).first()).toBeVisible();
  await expect(section.getByText(release ?? '', { exact: true })).toBeVisible();
  if (version) await expect(section.getByText(`v${version}`, { exact: true })).toBeVisible();
  if (config.release) expect(release, 'the release the configuration expects').toBe(config.release);
});
