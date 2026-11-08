import { expect, test, type Page } from '@playwright/test';

// Design round 40 (D114, D116, C4): the «Analizando» block of an answer that ran code, its
// figures and the cards of the files it wrote, against the local mock. The words of the message
// pick the demo variant (`mock/codeDemo.ts`).

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function pushRoute(page: Page, path: string): Promise<void> {
  await page.evaluate(
    `window.history.pushState({}, '', ${JSON.stringify(path)});
     window.dispatchEvent(new PopStateEvent('popstate'));`,
  );
}

/** What the browser logs for the failures these tests cause on purpose. */
const EXPECTED_NETWORK = [
  /^Failed to load resource: the server responded with a status of (429|503) .*$/,
];

test.describe.configure({ mode: 'serial' });

test.describe('Chat answers that run code', () => {
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

  async function ask(text: string) {
    await pushRoute(page, '/');
    await page.locator('#chat-input').fill(text);
    await page.locator('#chat-input').press('Enter');
    return page.locator('.msg-agent').last();
  }

  test('the block runs, ends «Analizado», and shows its figure and its files', async () => {
    const answer = await ask('analiza el CUR con código');
    await expect(answer.locator('.cr-code-t')).toHaveText('Analizando…');
    await expect(answer.locator('.ch-phase-t')).toHaveText('Ejecutando código…');
    const head = answer.getByRole('button', { name: /Analizado/ });
    await expect(head).toBeVisible({ timeout: 15_000 });
    await expect(head).toContainText('2 celdas · 5,0 s');
    // The figure is a blob: read from the API with the person's token.
    const figure = answer.getByRole('img', { name: 'costo_por_servicio.png' });
    await expect(figure).toHaveAttribute('src', /^blob:/, { timeout: 10_000 });
    // The files after the text: a card each, ready once their scan said.
    const card = answer.locator('.cr-file', { hasText: 'detalle_costos.xlsx' });
    await expect(card.getByRole('button', { name: /Descargar/ })).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('Excel · 209 KB · de');
    await head.click();
    await expect(answer.getByText('STDOUT')).toBeVisible();
    await expect(answer.getByText('STDERR')).toBeVisible();
    // The link of the text to a file of the answer downloads it.
    const download = page.waitForEvent('download');
    await answer.getByRole('button', { name: 'Excel con el detalle' }).click();
    expect((await download).suggestedFilename()).toBe('detalle_costos.xlsx');
  });

  test('a failed cell and its exception', async () => {
    const answer = await ask('analiza con código y una excepción');
    const head = answer.getByRole('button', { name: /^Error/ });
    await expect(head).toBeVisible({ timeout: 15_000 });
    await expect(answer.locator('.cr-code-sum')).toHaveText("KeyError: 'region'");
    await head.click();
    await expect(answer.getByText('EXCEPCIÓN')).toBeVisible();
  });

  test('a cell the guardrail hid shows nothing of itself', async () => {
    const answer = await ask('analiza con código que se bloquea');
    await answer.getByRole('button', { name: /Analizado/ }).click({ timeout: 15_000 });
    await expect(
      answer.getByText(
        'Mango no muestra el código ni la salida de esta celda: infringían una regla de seguridad.',
      ),
    ).toBeVisible();
  });

  test('a file the malware scan blocked, and the hourly limit of downloads', async () => {
    let answer = await ask('analiza con código; hay malware en el Excel');
    await expect(
      answer
        .locator('.cr-file', { hasText: 'detalle_costos.xlsx' })
        .getByText('El escaneo de malware bloqueó este archivo. No se puede descargar.'),
    ).toBeVisible({ timeout: 15_000 });
    answer = await ask('analiza con código y 60 descargas');
    const card = answer.locator('.cr-file', { hasText: 'detalle_costos.xlsx' });
    await card.getByRole('button', { name: /Descargar/ }).click({ timeout: 15_000 });
    await expect(
      card.getByText(
        'Llegaste al máximo de 60 descargas por hora. Podrás descargar de nuevo en 12 minutos.',
      ),
    ).toBeVisible();
  });

  test('«Cancelar» while a cell runs leaves the block «Pausado»', async () => {
    const answer = await ask('analiza el CUR con código, otra vez');
    await expect(answer.locator('.cr-code-t')).toHaveText('Analizando…');
    await page.getByRole('button', { name: /Detener|Cancelar/ }).click();
    await expect(page.locator('.cr-code-t').last()).toHaveText('Pausado');
  });

  test('the console stays clean', () => {
    const unexpected = consoleErrors.filter(
      (text) => !EXPECTED_NETWORK.some((pattern) => pattern.test(text)),
    );
    expect(unexpected).toEqual([]);
  });
});
