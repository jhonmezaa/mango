import { expect, test, type Page } from '@playwright/test';

// Agent Builder › Acceso › Personas (Claude Design, October 2026 round) against the local mock,
// whose directory has usuario1–9@empresa.com. The app keeps its tokens in memory only, so every
// step navigates inside the SPA.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

test('people are added by email and shown by email', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Marketplace', exact: true }).first().click();
  await page.getByRole('link', { name: 'Nuevo agente', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Nuevo agente' })).toBeVisible();

  const email = page.getByRole('textbox', { name: 'Agregar persona por correo' });
  const add = page.getByRole('button', { name: 'Agregar', exact: true });
  await expect(add).toBeDisabled();

  await email.fill('no-es-correo');
  await expect(page.getByText('Escribe un correo válido')).toBeVisible();
  await expect(add).toBeDisabled();

  await email.fill('nadie@empresa.com');
  await add.click();
  await expect(page.getByText('Ese correo no está en el directorio')).toBeVisible();

  await email.fill('Usuario3@empresa.com');
  await email.press('Enter');
  await expect(email).toHaveValue('');
  await expect(page.getByText('Ese correo no está en el directorio')).toHaveCount(0);
  // The chip shows the email; the identifier the API stores is never on screen.
  await expect(page.getByTitle('usuario3@empresa.com')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Quitar usuario3@empresa.com' })).toBeVisible();
  await expect(page.getByText('00000000-0000-4000-8000-000000000003')).toHaveCount(0);

  await page.getByRole('button', { name: 'Quitar usuario3@empresa.com' }).click();
  await expect(page.getByTitle('usuario3@empresa.com')).toHaveCount(0);
});
