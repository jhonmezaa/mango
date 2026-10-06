import { expect, type Page, type Response } from '@playwright/test';

import type { Credentials } from './config.ts';
import type { TotpLedger } from './totp.ts';

// Sign-in with password and TOTP, and sign-out, through the screens of the application. The
// password and the code are typed into the page and never logged or returned.

export const SESSION_COOKIE = '__Host-mango_session';

const pathOf = (url: string): string => new URL(url).pathname;

export const isSessionCall =
  (method: 'POST' | 'DELETE') =>
  (response: Response): boolean =>
    pathOf(response.url()) === '/api/session' && response.request().method() === method;

/**
 * Signs in on the sign-in form and waits until the server has taken the session (the cookie is
 * set by `POST /api/session`): a reload or a closed browser before that would lose it.
 */
export async function signIn(page: Page, who: Credentials, ledger: TotpLedger): Promise<Response> {
  await page.goto('/');
  await page.getByLabel('Correo').fill(who.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verificación en dos pasos' })).toBeVisible();
  const code = await ledger.next(who.email, who.totp);
  const started = page.waitForResponse(isSessionCall('POST'));
  // If typing fails first, the pending wait must not become an unhandled rejection.
  started.catch(() => undefined);
  await page.getByLabel('Dígito 1').click();
  await page.keyboard.type(code);
  await page.getByRole('button', { name: 'Verificar y entrar' }).click();
  const response = await started;
  await expect(page.getByRole('navigation').first()).toBeVisible();
  return response;
}

/** Signs out from the account menu and waits for the server to end the session. */
export async function signOut(page: Page): Promise<Response> {
  const ended = page.waitForResponse(isSessionCall('DELETE'));
  ended.catch(() => undefined);
  await page.getByRole('button', { name: /^Cuenta de / }).click();
  await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
  await expect(page.getByLabel('Correo')).toBeVisible();
  return ended;
}
