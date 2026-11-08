import { expect, test, type Page } from '@playwright/test';

// Design round 40 (D120, D121): a chat turn read in `v1` patches, cut and resumed, against the
// local mock. The mock's demo words cut the connection («reconecta»), refuse the next 12
// («no reconecta»), lose the turn halfway («interrumpido») or find another tab's turn in flight
// («otra pestaña»). Opening a conversation reads its turn in flight from the API (R3b).

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

/** In-app navigation (a reload would sign the user out). */
async function pushRoute(page: Page, path: string): Promise<void> {
  await page.evaluate(
    `window.history.pushState({}, '', ${JSON.stringify(path)});
     window.dispatchEvent(new PopStateEvent('popstate'));`,
  );
}

/** What the browser itself logs for the cuts and the 502 these tests cause on purpose. */
const EXPECTED_NETWORK = [
  /^Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING$/,
  /^Failed to load resource: the server responded with a status of 502 \(Bad Gateway\)$/,
];

test.describe.configure({ mode: 'serial' });

test.describe('Chat turns that reconnect', () => {
  let page: Page;
  const consoleErrors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await signIn(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  // Design round 40 (D120): the stream of the turn is cut and read again from where it was.
  test('a cut turn reconnects and its answer goes on without repeating', async () => {
    await pushRoute(page, '/');
    await page.locator('#chat-input').fill('se corta y reconecta');
    await page.locator('#chat-input').press('Enter');
    const answer = page.locator('.msg-agent').last();
    await expect(answer.locator('.cr-conn.is-ok')).toHaveText(
      'Reconectado. La respuesta sigue donde iba.',
      { timeout: 30_000 },
    );
    await expect(
      page.locator('[aria-live="polite"].sr-only', { hasText: 'Respuesta completa. ' }),
    ).toHaveCount(1, { timeout: 30_000 });
    // Each part of the answer once: nothing applied twice after resuming.
    await expect(answer.getByText('Principal driver:')).toHaveCount(1);
    await expect(answer.locator('.cr-conn')).toHaveCount(0, { timeout: 5_000 });
  });

  test('a turn that cannot reconnect offers «Volver a conectar»', async () => {
    await pushRoute(page, '/');
    await page.locator('#chat-input').fill('se corta y no reconecta');
    await page.locator('#chat-input').press('Enter');
    const answer = page.locator('.msg-agent').last();
    await expect(answer.locator('.cr-conn')).toContainText('Se cortó la conexión. Reconectando…');
    await expect(answer.locator('.cr-conn .mono')).toHaveText(/^intento \d+ de 12$/);
    // «Cancelar» stays while it reconnects.
    await expect(page.getByRole('button', { name: 'Cancelar respuesta' })).toBeVisible();
    const alert = answer.getByRole('alert');
    await expect(alert).toContainText('No se pudo reconectar.', { timeout: 60_000 });
    await alert.getByRole('button', { name: 'Volver a conectar' }).click();
    await expect(
      page.locator('[aria-live="polite"].sr-only', { hasText: 'Respuesta completa. ' }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(answer.getByText('Principal driver:')).toHaveCount(1);
  });

  test('a turn Mango lost halfway says so, without «Reintentar», also when opened again', async () => {
    await pushRoute(page, '/');
    await page.locator('#chat-input').fill('turno interrumpido');
    await page.locator('#chat-input').press('Enter');
    const answer = page.locator('.msg-agent').last();
    await expect(answer.getByRole('status')).toContainText('Respuesta interrumpida.', {
      timeout: 30_000,
    });
    await expect(answer.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    // From the history (its `stop_code`), the same notice.
    const conversation = new URL(page.url()).pathname;
    await pushRoute(page, '/');
    await pushRoute(page, conversation);
    await expect(page.locator('.msg-agent').last().getByRole('status')).toContainText(
      'Respuesta interrumpida.',
    );
  });

  test('a turn still running is read live when its conversation opens again', async () => {
    await pushRoute(page, '/');
    await page.locator('#chat-input').fill('hola');
    await page.locator('#chat-input').press('Enter');
    await expect(page).toHaveURL(/\/c\/[0-9a-f]{32}$/);
    await expect(page.locator('.msg-agent').last()).toContainText('gasto', { timeout: 30_000 });
    const conversation = new URL(page.url()).pathname;
    await pushRoute(page, '/');
    await pushRoute(page, conversation);
    await expect(page.getByRole('button', { name: 'Cancelar respuesta' })).toBeVisible();
    await expect(
      page.locator('[aria-live="polite"].sr-only', { hasText: 'Respuesta completa. ' }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.msg-agent').last().getByText('Principal driver:')).toHaveCount(1);
  });

  test('another tab answering: the message stays, that turn is shown live', async () => {
    await pushRoute(page, '/');
    await page.locator('#chat-input').fill('desde otra pestaña');
    await page.locator('#chat-input').press('Enter');
    await expect(
      page.getByText(
        'Tu mensaje no se envió: hay una respuesta en curso en esta conversación, desde otra pestaña. Sigue en el cuadro de texto; envíalo cuando termine.',
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#chat-input')).toHaveValue('desde otra pestaña');
    await expect(page.locator('.msg-user-origin')).toHaveText('Desde otra pestaña');
    await expect(page.locator('.msg-user-bubble').last()).toHaveText(
      '¿Qué cuentas explican el aumento de EC2?',
    );
    await expect(
      page.locator('[aria-live="polite"].sr-only', { hasText: 'Respuesta completa. ' }),
    ).toHaveCount(1, { timeout: 30_000 });
  });

  test('«Cancelar» stops the answer with the round 40 note', async () => {
    await pushRoute(page, '/');
    await page.locator('#chat-input').fill('hola');
    await page.locator('#chat-input').press('Enter');
    // Once it wrote something: what was written is kept with the note.
    await expect(page.locator('.msg-agent').last()).toContainText('gasto', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Cancelar respuesta' }).click();
    const note =
      'Respuesta detenida. El turno se cobra entero y tu próxima pregunta empieza de nuevo: el agente solo recordará lo que se ve aquí.';
    await expect(page.locator('.msg-stopped').last()).toHaveText(note);
    // From the history (its `stop_code`), the same note.
    await expect(page).toHaveURL(/\/c\/[0-9a-f]{32}$/);
    const conversation = new URL(page.url()).pathname;
    await pushRoute(page, '/');
    await pushRoute(page, conversation);
    await expect(page.locator('.msg-stopped').last()).toHaveText(note);
  });

  test('leaves no other errors in the console', () => {
    expect(
      consoleErrors.filter((text) => !EXPECTED_NETWORK.some((rule) => rule.test(text))),
    ).toEqual([]);
  });
});
