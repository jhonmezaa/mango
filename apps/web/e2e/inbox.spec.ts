import { expect, test, type Page } from '@playwright/test';

// La Bandeja (D83) against the local mock: the approvals the mock user can sign and the notices
// of their task runs, reading, archiving, «Ver resultado» into Schedules and «Marcar todo como
// leído» with the sidebar counter. The app keeps its tokens in memory only, so every step
// navigates inside the SPA.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

test('the Bandeja lists what to sign and the runs of my tasks, and opens a result', async ({
  page,
}) => {
  await signIn(page);
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  // The sidebar shows the unread count the API gives.
  await expect(nav.getByRole('link', { name: /^Bandeja, \d+ sin leer$/ })).toBeVisible();
  await nav.getByRole('link', { name: /^Bandeja/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Bandeja' })).toBeVisible();
  await expect(page.getByText(/\d+ sin leer/).first()).toBeVisible();

  const list = page.getByRole('listbox', { name: 'Avisos' });
  await expect(
    list.getByRole('option').filter({ hasText: 'Te piden aprobar:' }).first(),
  ).toBeVisible();
  const completed = list
    .getByRole('option')
    .filter({ hasText: 'Investigar anomalías de costo · completada' })
    .first();
  // The first line of the report, without its Markdown.
  await expect(completed).toContainText('Anomalía en Amazon EC2');
  await expect(page.getByRole('tab', { name: /Menciones/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  );

  await completed.click();
  await expect(page.getByRole('heading', { level: 2, name: /completada$/ })).toBeVisible();
  await expect(page.getByText('Ejecución', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Ver resultado/ }).click();
  await expect(page).toHaveURL(/\/schedules\/[0-9a-f]{32}\/run\/[0-9a-f]{32}$/);
  await expect(
    page.getByText('Solo tú ves este resultado: se obtuvo con tu acceso.'),
  ).toBeVisible();
});

test('a notice is archived and comes back; everything is marked as read', async ({ page }) => {
  await signIn(page);
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  await nav.getByRole('link', { name: /^Bandeja/ }).click();
  const list = page.getByRole('listbox', { name: 'Avisos' });
  const notice = list.getByRole('option').filter({ hasText: 'Budget check diario · completada' });
  await notice.first().click();
  await page.getByRole('button', { name: 'Archivar' }).click();
  await expect(notice).toHaveCount(0);

  // Design 2026-10-16b: «Archivado» is a button next to the count, not a tab.
  await page.getByRole('button', { name: 'Archivado', exact: true }).click();
  await expect(page).toHaveURL(/\/inbox\/archived$/);
  await list.getByRole('option').filter({ hasText: 'Budget check diario' }).first().click();
  await page.getByRole('button', { name: 'Desarchivar' }).click();
  await expect(page.getByText('Nada por aquí.')).toBeVisible();

  await page.getByRole('button', { name: 'Volver a la bandeja' }).click();
  await page.getByRole('button', { name: 'Marcar todo como leído' }).click();
  await expect(page.getByText('Todo al día')).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Bandeja', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Sin leer' }).click();
  await expect(page.getByText('Nada por aquí.')).toBeVisible();
});
