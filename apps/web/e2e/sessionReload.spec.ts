import { expect, test, type Page } from '@playwright/test';

// The session cookie of mango-api (D63) against the local mock: a reload keeps the session and
// signing out ends it. The cookie is HttpOnly, so the tests only see its effects and that
// nothing of the session reaches Web Storage.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  // The server takes the session right after the sign-in; a reload before that would lose it.
  const started = page.waitForResponse(
    (r) => r.url().endsWith('/api/session') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  expect((await started).status()).toBe(204);
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Cuenta de / }).click();
  await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
  await expect(page.getByLabel('Correo')).toBeVisible();
}

test('a reload keeps the session, and signing out ends it', async ({ page, context }) => {
  // Asking for a session that does not exist is not an error: nothing reaches the console.
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await signIn(page);

  await page.reload();
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(page.getByLabel('Correo')).toHaveCount(0);

  // The cookie is out of reach of the page, and no token is in Web Storage.
  const [cookie] = (await context.cookies()).filter((c) => c.name === '__Host-mango_session');
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
  // Evaluated in the page (as text: this file is not compiled with the DOM types).
  const seen = await page.evaluate<string>(
    'JSON.stringify([document.cookie, Object.entries(localStorage), Object.entries(sessionStorage)])',
  );
  expect(seen).not.toMatch(/mango_session|token|refresh|eyJ/i);

  // A new tab of the same browser is signed in too.
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByRole('navigation').first()).toBeVisible();

  await signOut(page);
  // The other tab follows, and no reload brings the session back.
  await expect(second.getByLabel('Correo')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Correo')).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  expect((await context.cookies()).filter((c) => c.name === '__Host-mango_session')).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('a deep link survives the reload', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Aprobaciones', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Aprobaciones' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Aprobaciones' })).toBeVisible();
});
