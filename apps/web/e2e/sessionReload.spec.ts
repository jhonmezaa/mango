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

  // The recovered session is in Auditoría only with «Mostrar lecturas»; its start, always.
  await page.getByRole('link', { name: 'Audit log', exact: true }).first().click();
  await expect(page.getByText('Sesión iniciada').first()).toBeVisible();
  await expect(page.getByText('Sesión recuperada')).toHaveCount(0);
  await page.getByRole('switch').click();
  await expect(page.getByText('Sesión recuperada').first()).toBeVisible();

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
  await expect(second.getByRole('status')).toHaveText(
    'Cerraste sesión en otra pestaña. Vuelve a entrar para seguir.',
  );
  await expect(page.getByText('Cerraste sesión en otra pestaña.')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Correo')).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  expect((await context.cookies()).filter((c) => c.name === '__Host-mango_session')).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

// Design round 27 · «Recargar la página»: no «Recuperando tu sesión…»; the skeletons when this
// browser had a session, the neutral cover when not, and the sign-in says when it ended.
test('a reload paints the skeletons or the cover, never the sign-in frame', async ({ page }) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/session/refresh', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/');
  const cover = page.getByRole('progressbar', { name: 'Cargando Mango' });
  await expect(cover).toHaveClass(/boot-cover/);
  await expect(page.getByText('Recuperando tu sesión…')).toHaveCount(0);
  // A long wait adds only the thin bar.
  await expect(page.locator('.boot-bar')).toBeVisible();
  release();
  await expect(page.getByLabel('Correo')).toBeVisible();
  await page.unroute('**/api/session/refresh');

  await signIn(page);
  let releaseAgain: () => void = () => undefined;
  const heldAgain = new Promise<void>((resolve) => (releaseAgain = resolve));
  await page.route('**/api/session/refresh', async (route) => {
    await heldAgain;
    await route.continue();
  });
  await page.reload();
  await expect(page.getByRole('progressbar', { name: 'Cargando Mango' })).toHaveClass(/boot-app/);
  await expect(page.getByLabel('Correo')).toHaveCount(0);
  releaseAgain();
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Cargando Mango' })).toHaveCount(0);
});

test('a reload after the session ended says so on the sign-in', async ({ page, context }) => {
  await signIn(page);
  // The server forgot the session (it expired or was revoked): only the local hint is left.
  await context.clearCookies();
  await page.reload();
  await expect(page.getByLabel('Correo')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(
    'Tu sesión terminó. Vuelve a entrar para seguir.',
  );
  // Said once: the next load is the plain sign-in.
  await page.reload();
  await expect(page.getByLabel('Correo')).toBeVisible();
  await expect(page.getByText('Tu sesión terminó.')).toHaveCount(0);
});

test('a deep link survives the reload', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Aprobaciones', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Aprobaciones' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Aprobaciones' })).toBeVisible();
});

// An outage of the renewal is not the end of the session: only the 204 of
// `POST /api/session/refresh` says there is none. The 503 is what mango-api answers when
// Cognito, KMS or the sessions table do not respond (`session_unavailable`).
const GENERIC = 'Ocurrió un error inesperado. Inténtalo de nuevo.';

async function renewalDown(page: Page): Promise<{ calls: () => number }> {
  let calls = 0;
  await page.route('**/api/session/refresh', async (route) => {
    calls += 1;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        error: { code: 'session_unavailable', message: 'the session service is unavailable' },
      }),
    });
  });
  return { calls: () => calls };
}

test('a reload while the renewal answers 503 keeps the session', async ({ page, context }) => {
  await signIn(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByRole('navigation').first()).toBeVisible();

  const down = await renewalDown(page);
  await page.reload();
  // It asks again a few times behind the skeletons (design round 27), then says so and stops.
  await expect(page.getByRole('progressbar', { name: 'Cargando Mango' })).toHaveClass(/boot-app/);
  await expect(page.getByRole('alert')).toContainText('No se pudo abrir Mango', {
    timeout: 15_000,
  });
  await expect(page.getByRole('alert')).toContainText(
    'Mango no responde. Inténtalo de nuevo en unos minutos.',
  );
  // With the server down the cookie cannot be revoked: no «Cerrar sesión» here.
  await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toHaveCount(0);
  expect(down.calls()).toBe(4);
  // Not the sign-in form, and the session is still there: the cookie and the other tab.
  await expect(page.getByLabel('Correo')).toHaveCount(0);
  expect((await context.cookies()).filter((c) => c.name === '__Host-mango_session')).toHaveLength(
    1,
  );
  await expect(second.getByRole('navigation').first()).toBeVisible();
  await expect(second.getByLabel('Correo')).toHaveCount(0);

  // The renewal is back: «Reintentar» recovers the session without a new sign-in.
  await page.unroute('**/api/session/refresh');
  await page.getByRole('button', { name: 'Reintentar' }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(page.getByLabel('Correo')).toHaveCount(0);
  expect(down.calls()).toBe(4);

  await signOut(page);
  await expect(second.getByLabel('Correo')).toBeVisible();
});

test('a message sent while the renewal answers 503 fails without signing out', async ({ page }) => {
  // The clock of the page only: the access token (1 h) is due for renewal after 54 minutes.
  await page.clock.install();
  await signIn(page);
  // Down before the clock moves: the shell's background requests (the Bandeja counter, every
  // minute) would otherwise renew the token on the way and the turn would not need to.
  const down = await renewalDown(page);
  await page.clock.fastForward('55:00');

  await page.locator('#chat-input').fill('hola');
  await page.locator('#chat-input').press('Enter');
  await expect(page.getByText(GENERIC)).toBeVisible();
  // The turn asked for the renewal; so does whatever the page loads after it.
  expect(down.calls()).toBeGreaterThanOrEqual(1);
  await expect(page.getByText('Tu sesión terminó. Vuelve a entrar para seguir.')).toHaveCount(0);
  await expect(page.getByLabel('Correo')).toHaveCount(0);
  await expect(page.getByRole('navigation').first()).toBeVisible();

  // The renewal is back: the same message goes out again and gets its answer.
  await page.unroute('**/api/session/refresh');
  const renewed = page.waitForResponse((r) => r.url().endsWith('/api/session/refresh'));
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/chat'));
  // The one of the message: the history, which failed too, has its own.
  await page.getByText(GENERIC).locator('..').getByRole('button', { name: 'Reintentar' }).click();
  expect((await renewed).status()).toBe(200);
  expect((await sent).status()).toBe(200);
  // The failed turn stays in the conversation; the new one is answered below it.
  await expect(page.getByLabel('Correo')).toHaveCount(0);

  await signOut(page);
});
