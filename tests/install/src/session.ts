import { expect, type Page, type Response } from '@playwright/test';

import {
  CHALLENGE_TARGET,
  refusalOf,
  withOneRetry,
  type Attempt,
  type Refusal,
} from './cognito.ts';
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

export interface RefusedCode extends Refusal {
  /** The answer of Cognito, for the watch of the caller. Its body is never kept. */
  response: Response;
}

export interface SignInOptions {
  /** Told when Cognito refused the first code, before the one retry. */
  onCodeRefused?: (refused: RefusedCode) => void;
}

/** Cognito refusing the answer to a sign-in challenge; after the password, that is the code. */
const isRefusedChallenge = (response: Response): boolean =>
  response.status() >= 400 &&
  response.request().method() === 'POST' &&
  response.request().headers()['x-amz-target'] === CHALLENGE_TARGET;

async function attempt(
  page: Page,
  who: Credentials,
  ledger: TotpLedger,
): Promise<Attempt<Response, RefusedCode>> {
  await page.goto('/');
  await page.getByLabel('Correo').fill(who.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verificación en dos pasos' })).toBeVisible();
  const code = await ledger.next(who.email, who.totp);
  const started = page
    .waitForResponse(isSessionCall('POST'))
    .then((response) => ({ ok: true as const, value: response }));
  // If typing fails first, the pending wait must not become an unhandled rejection.
  started.catch(() => undefined);
  // Only the exception name of the answer is read; the request, which carries the code, never.
  const refused = page
    .waitForResponse(isRefusedChallenge)
    .then(async (response) => ({
      ok: false as const,
      refusal: {
        ...refusalOf(response.status(), await response.json().catch(() => null)),
        response,
      },
    }))
    // No refusal is the usual case: then only `started` decides, with its own timeout.
    .catch(() => new Promise<never>(() => undefined));
  await page.getByLabel('Dígito 1').click();
  await page.keyboard.type(code);
  await page.getByRole('button', { name: 'Verificar y entrar' }).click();
  return Promise.race([started, refused]);
}

/**
 * Signs in on the sign-in form and waits until the server has taken the session (the cookie is
 * set by `POST /api/session`): a reload or a closed browser before that would lose it.
 *
 * Cognito refuses a code it has already accepted in its 30 s window, and the ledger cannot
 * know of a sign-in another process made. A refused code is tried once more, from the form and
 * with the code of the next window; a second refusal fails saying so, never with a timeout.
 */
export async function signIn(
  page: Page,
  who: Credentials,
  ledger: TotpLedger,
  options: SignInOptions = {},
): Promise<Response> {
  const response = await withOneRetry(
    () => attempt(page, who, ledger),
    (refused) => options.onCodeRefused?.(refused),
  );
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
