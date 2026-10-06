import { credentialsOf, ROLES } from '../src/config.ts';
import { expect, leaves, test } from '../src/fixtures.ts';
import { isSessionCall, SESSION_COOKIE, signIn, signOut } from '../src/session.ts';

// Sign-in with password and TOTP, the session cookie, a reload, and a sign-out that takes the
// other tab out. With the least privileged user there is. Leaves: one «Sesión iniciada», the
// «Sesión recuperada» of each load and one «Sesión cerrada» in Auditoría.

test('sign-in with password and TOTP, reload, and sign-out that ends every tab', async ({
  config,
  ledger,
  ownBrowser,
}, testInfo) => {
  const role = [...ROLES].reverse().find((candidate) => config.users[candidate]);
  test.skip(!role, 'no hay ningún usuario configurado');
  if (!role) return;
  leaves(testInfo, `Auditoría: una sesión iniciada, recuperada y cerrada de «${role}».`);

  const { context, page } = await ownBrowser();
  let signedIn = false;
  try {
    const started = await signIn(page, credentialsOf(config, role), ledger);
    signedIn = true;
    expect(started.status()).toBe(204);

    // The cookie as the server sets it: only its attributes are read, never its value.
    const header = (await started.headerValue('set-cookie')) ?? '';
    const attributes = header
      .split(';')
      .slice(1)
      .map((part) => part.trim().toLowerCase());
    expect(header.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(attributes).toEqual(
      expect.arrayContaining(['httponly', 'secure', 'samesite=strict', 'path=/']),
    );
    expect(attributes.some((part) => part.startsWith('domain='))).toBe(false);
    const hours = (
      (await (await context.request.get('/config.json')).json()) as {
        auth: { sessionHours: number };
      }
    ).auth.sessionHours;
    const maxAge = Number(/max-age=(\d+)/i.exec(header)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(hours * 3600);
    const [cookie] = (await context.cookies()).filter((c) => c.name === SESSION_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });

    // Nothing of the session is within reach of a script of the page.
    const seen = await page.evaluate(() =>
      JSON.stringify([
        document.cookie,
        Object.entries(window.localStorage),
        Object.entries(window.sessionStorage),
      ]),
    );
    expect(seen).not.toMatch(/mango_session|token|refresh|eyJ/i);

    // A reload keeps the session, and the sign-in form never shows meanwhile.
    const renewed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/session/refresh',
    );
    await page.reload();
    expect((await renewed).status()).toBe(200);
    await expect(page.getByRole('navigation').first()).toBeVisible();
    await expect(page.getByLabel('Correo')).toHaveCount(0);

    // Another tab of the same browser is inside too.
    const second = await context.newPage();
    await second.goto('/marketplace');
    await expect(second.getByRole('navigation').first()).toBeVisible();

    const ended = await signOut(page);
    signedIn = false;
    expect(ended.status()).toBe(204);
    await expect(second.getByLabel('Correo')).toBeVisible();
    await expect(second.getByRole('status')).toHaveText(
      'Cerraste sesión en otra pestaña. Vuelve a entrar para seguir.',
    );
    await page.reload();
    await expect(page.getByLabel('Correo')).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    expect((await context.cookies()).filter((c) => c.name === SESSION_COOKIE)).toEqual([]);
  } finally {
    // A failure half-way never leaves the session open on the server.
    if (signedIn) {
      const ended = page.waitForResponse(isSessionCall('DELETE')).catch(() => null);
      await page.goto('/').catch(() => undefined);
      await signOut(page).catch(() =>
        context.request.delete('/api/session', {
          headers: { Origin: config.baseUrl, 'Sec-Fetch-Site': 'same-origin' },
        }),
      );
      await ended;
    }
  }
});
