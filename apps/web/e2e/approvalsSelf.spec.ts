import { expect, test, type Page } from '@playwright/test';

// The tools of «Tickets de Mango» in Ajustes › Aprobaciones › Políticas (D112 (8)), against the
// local mock: born self-confirmed, they can only be hardened to «Siempre».

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

test('the ticket tools read «La persona confirma cada llamada» and only harden to «Siempre»', async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Aprobaciones', exact: true }).first().click();
  await page.getByRole('tab', { name: 'Políticas' }).click();

  for (const tool of ['create_ticket', 'update_ticket', 'comment_ticket']) {
    const row = page.locator('.pol-tr').filter({ hasText: `mango-tickets.${tool}` });
    await expect(row).toContainText('Tickets de Mango');
    await expect(row).toContainText('La persona confirma cada llamada');
    await expect(row.getByText('—', { exact: true })).toHaveCount(2);
    await expect(row).not.toContainText('Siempre');
  }

  await page
    .getByRole('button', { name: 'Editar política de mango-tickets.create_ticket' })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Siempre' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Según monto' })).toBeDisabled();
  await expect(
    dialog.getByText(
      'Hoy: la persona del chat confirma cada llamada. Con «Siempre», cada llamada pide aprobadores. Aprobadores y vencimiento se eligen después de marcar «Siempre».',
    ),
  ).toBeVisible();
  // Design round 38: approvers and expiry are dimmed and inert until «Siempre» is chosen.
  const approvers = dialog.locator('.g-field').filter({ hasText: 'Aprobadores necesarios' });
  await expect(approvers).toHaveClass(/pol-off/);
  await expect(approvers).toHaveCSS('opacity', '0.45');
  await dialog.getByRole('button', { name: 'Siempre' }).click();
  await expect(approvers).not.toHaveClass(/pol-off/);
  await expect(approvers.getByRole('button', { name: '2' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toBeHidden();
});
