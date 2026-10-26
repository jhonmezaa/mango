import { expect, test, type Page } from '@playwright/test';

// Playground (D91, design round 21) against the local mock (`mock/playground.ts`). The question
// picks what the mock answers. The app keeps its tokens in memory only, so every step navigates
// inside the SPA.

const SHOTS = process.env.MANGO_E2E_SHOTS;

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

async function ask(page: Page, question: string): Promise<void> {
  await page.getByLabel('Mensaje de prueba').fill(question);
  await page.getByRole('button', { name: 'Ejecutar', exact: true }).click();
}

const cards = (page: Page) => page.locator('.pg-card');

test.describe.configure({ mode: 'serial' });

test.describe('Playground: test a version before sending it', () => {
  let page: Page;
  const consoleErrors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await signIn(page);
    const link = page.getByRole('link', { name: 'Playground', exact: true }).first();
    if (!(await link.isVisible())) await page.getByRole('button', { name: 'Construir' }).click();
    await link.click();
    await expect(page).toHaveURL(/\/playground$/);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('lists drafts and published agents, and starts on the first draft', async () => {
    const select = page.getByLabel('Qué probar');
    await expect(select.locator('optgroup[label="Tus borradores"] option')).not.toHaveCount(0);
    await expect(select.locator('optgroup[label="Publicados que editas"] option')).not.toHaveCount(
      0,
    );
    await expect(page.getByLabel('System prompt')).toBeVisible();
    await expect(page.getByText('Prueba antes de enviar a aprobación')).toBeVisible();
    await shot(page, '01-start');
  });

  test('a rejected draft shows the reviewer reason', async () => {
    const select = page.getByLabel('Qué probar');
    await select.selectOption({ label: 'Resumen semanal · rechazado' });
    await expect(
      page.getByText('Rechazado: “Falta indicar a quién reporta y el rol.”'),
    ).toBeVisible();
    await expect(page.locator('.pg-before')).toContainText('Antes de enviar');
  });

  test('one question streams an answer with its tools, time, tokens and cost', async () => {
    await ask(page, '¿Cuánto creció el gasto?');
    const card = cards(page).first();
    await expect(card.locator('.pg-foot')).toContainText('USD 0,0123', { timeout: 15_000 });
    await expect(card.locator('.pg-foot')).toContainText('1.234 in · 321 out');
    await expect(card.locator('table')).toBeVisible();
    await card.getByRole('button', { name: '1 tool' }).click();
    await expect(card.locator('.pg-trace')).toContainText(/get_cost_and_usage\d+,\d s · bien/);
    await card.getByRole('button', { name: 'Útil', exact: true }).click();
    await expect(page.getByText('1 útiles · 0 no')).toBeVisible();
    await expect(card.getByRole('button', { name: /Guardar como caso/ })).toBeDisabled();
    await shot(page, '02-answer');
  });

  test('a write tool stops the test and is never run', async () => {
    await ask(page, 'Haz rollback del deploy');
    const card = cards(page).first();
    await expect(card.getByText('pidió escritura')).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('La prueba se detuvo aquí: el agente pidió stop_instances');
    await card.getByRole('button', { name: '2 tools' }).click();
    await expect(card.locator('.pg-trace')).toContainText('pediría aprobación · no se ejecuta');
  });

  test('a failure halfway keeps what arrived and offers to retry', async () => {
    await ask(page, 'Esto falla');
    const card = cards(page).first();
    await expect(card.getByRole('alert')).toContainText('No se pudo completar la respuesta.', {
      timeout: 15_000,
    });
    await expect(card.locator('.md')).toContainText('Consulté');
    await expect(card.getByRole('button', { name: 'Reintentar' })).toBeEnabled();
  });

  test('«Ejecutar todas» queues four questions and runs two at a time', async () => {
    await page.getByRole('button', { name: 'Limpiar' }).click();
    await page.getByRole('button', { name: 'Ejecutar todas' }).click();
    await expect(page.locator('.pg-run')).toHaveCount(4);
    await expect(
      page.getByText('En cola · empieza cuando termine otra prueba.').first(),
    ).toBeVisible();
    await shot(page, '03-queue');
    // The guardrail answers the security test.
    await expect(page.locator('.pg-card .badge', { hasText: 'Guardrail' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('.pg-foot')).toHaveCount(4, { timeout: 20_000 });
  });

  test('comparing with the published version runs one test per column', async () => {
    await page.getByRole('button', { name: 'Limpiar' }).click();
    await page.getByLabel('Qué probar').selectOption({ index: 0 });
    await page.getByRole('button', { name: 'Con publicado' }).click();
    await expect(page.getByText('Son dos pruebas por pregunta')).toBeVisible();
    await ask(page, 'Compara');
    const run = page.locator('.pg-run').first();
    await expect(run.locator('.pg-card')).toHaveCount(2);
    await expect(run.locator('.pg-card').first()).toContainText('Publicado');
    await expect(run.locator('.pg-card').nth(1)).toContainText('Borrador');
    await expect(run.locator('.pg-foot')).toHaveCount(2, { timeout: 20_000 });
    await shot(page, '04-compare');
    await page.getByRole('button', { name: 'No', exact: true }).click();
  });

  test('a likely secret in the prompt blocks every test', async () => {
    const prompt = page.getByLabel('System prompt');
    const original = await prompt.inputValue();
    // The example key of the AWS documentation: the secret scanner knows it is not real.
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    await prompt.fill(`${original}\n${secret}`);
    await expect(page.getByText('Hay un posible secreto en el prompt')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ejecutar todas' })).toBeDisabled();
    await expect(page.getByText('Cambios sin guardar')).toBeVisible();
    await shot(page, '05-secret');
    await prompt.fill(original);
    await expect(page.getByText('Hay un posible secreto en el prompt')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ejecutar todas' })).toBeEnabled();
  });

  test('an exhausted agent budget says whose it is', async () => {
    await ask(page, 'Prueba sin presupuesto del agente');
    await expect(page.getByText(/El presupuesto mensual de .+ se agotó/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: 'Ejecutar todas' })).toBeDisabled();
    // Another version starts without the notice.
    await page.getByLabel('Qué probar').selectOption({ index: 1 });
    await expect(page.getByRole('button', { name: 'Ejecutar todas' })).toBeEnabled();
  });

  test('at 420px the panel stacks over the answers, without horizontal scroll', async () => {
    await page.setViewportSize({ width: 420, height: 860 });
    await expect(page.locator('.app')).toHaveClass(/app-mobile/);
    await expect(page.getByLabel('System prompt')).toBeVisible();
    await expect
      .poll(() => page.evaluate<number>('document.documentElement.scrollWidth'))
      .toBeLessThanOrEqual(420);
    // The panel is not a box of its own: the whole grid scrolls.
    const side = await page.evaluate<number>(
      "(() => { const el = document.querySelector('.pg-side'); return el.scrollHeight - el.clientHeight; })()",
    );
    expect(side).toBeLessThanOrEqual(1);
    await shot(page, '07-narrow');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('the rate limit counts down', async () => {
    await ask(page, 'Llegué al límite');
    await expect(page.getByText('Llegaste al límite de pruebas')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Podrás probar de nuevo en \d+ s\./)).toBeVisible();
    await shot(page, '06-rate');
    await page.getByLabel('Qué probar').selectOption({ index: 0 });
  });

  test('an installation without the Playground says so', async () => {
    await ask(page, 'no disponible');
    await expect(
      page.getByText('El Playground no está disponible en esta instalación'),
    ).toBeVisible({ timeout: 15_000 });
    // The 429 and the 503 above are answers the screen shows; nothing else may log an error.
    expect(consoleErrors.filter((text) => !/^Failed to load resource/.test(text))).toEqual([]);
  });
});
