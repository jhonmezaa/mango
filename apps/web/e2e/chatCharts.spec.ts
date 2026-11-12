import { expect, test, type Locator, type Page } from '@playwright/test';

// Design rounds 40 and 41 (D118, G1 and T1): the chart and the table of an answer that ran code,
// against the local mock. The words of the message pick the demo variant (`mock/codeDemo.ts`).

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
  /^Failed to load resource: the server responded with a status of (409|422|503) .*$/,
];

test.describe.configure({ mode: 'serial' });

test.describe('Charts and tables of an answer that ran code', () => {
  let page: Page;
  const consoleErrors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await signIn(page);
  });

  test.afterAll(async () => {
    await page.context().close();
  });

  async function ask(text: string): Promise<Locator> {
    await pushRoute(page, '/');
    await page.locator('#chat-input').fill(text);
    await page.locator('#chat-input').press('Enter');
    const answer = page.locator('.msg-agent').last();
    await expect(answer.getByRole('button', { name: /Analizado/ })).toBeVisible({
      timeout: 15_000,
    });
    return answer;
  }

  test('a bar chart after the text, with its legend, the tooltip under the pointer and «Copiar datos»', async () => {
    const answer = await ask('analiza el CUR con código y una gráfica');
    const chart = answer.locator('.cr-chart', { hasText: 'Costo mensual por servicio' });
    await expect(chart.getByText('May – oct 2026 · Valores en USD')).toBeVisible({
      timeout: 10_000,
    });
    // Money in the browser's locale (es-MX: «USD 60,000»), without decimals.
    const usd = new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    });
    // Six months of three series: 18 bars, drawn as SVG by React (design round 41).
    const bars = chart.locator('svg.cr-svg rect[rx="2"]');
    await expect(bars).toHaveCount(18);
    await expect(chart.locator('.cr-legend li')).toHaveText(['EC2', 'RDS', 'S3']);
    await expect(chart.locator('svg.cr-svg text', { hasText: usd.format(60000) })).toHaveCount(1);
    await bars.first().hover();
    const tip = chart.locator('.cr-tip');
    await expect(tip).toContainText('may');
    await expect(tip).toContainText(usd.format(41200));
    // The legend hides a series and the axis fits what is left.
    await chart.getByRole('button', { name: 'EC2', exact: true }).click();
    await expect(bars).toHaveCount(12);
    await expect(chart.locator('svg.cr-svg text', { hasText: usd.format(15000) })).toHaveCount(1);
    await chart.getByRole('button', { name: 'Mostrar todas' }).click();
    await expect(bars).toHaveCount(18);
    // The keyboard: Tab reaches the drawing, the arrows walk it, Escape lets go.
    const drawing = chart.getByRole('application');
    await drawing.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await expect(chart.locator('.cr-hover')).toHaveText(`jun · EC2 ${usd.format(42900)} · 2 de 6`);
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    // «Ver datos» and back.
    await chart.getByRole('button', { name: 'Ver datos' }).click();
    await expect(chart.getByRole('region', { name: /^Datos de Costo mensual/ })).toBeVisible();
    await chart.getByRole('button', { name: 'Ver gráfica' }).click();
    await expect(bars).toHaveCount(18);
    // Design order: bloque → figuras → texto → gráfica → tabla → archivos.
    // The e2e project has no DOM types: what is read of a node is typed here.
    const order = await answer
      .locator('.cr-code, .cr-figcard, .md, .cr-chart, .cr-table, .cr-file:not(.is-compact)')
      .evaluateAll((nodes: { className: string }[]) => nodes.map((n) => n.className.split(' ')[0]));
    expect(order).toEqual(['cr-code', 'cr-figcard', 'md', 'cr-chart', 'cr-table', 'cr-file']);
    await chart.getByRole('button', { name: 'Copiar datos' }).click();
    await expect(
      page.getByText('Datos copiados. Pégalos en Excel o en una hoja de cálculo.'),
    ).toBeVisible();
    const copied = await page.evaluate(() =>
      (
        globalThis as unknown as { navigator: { clipboard: { readText: () => Promise<string> } } }
      ).navigator.clipboard.readText(),
    );
    expect(copied.split('\n')[0]).toBe('mes\tEC2\tRDS\tS3');
    expect(copied.split('\n')[1]).toBe('may\t41200\t9800\t12800');
  });

  test('a table with a fixed header, 200 of its rows and the card of its CSV', async () => {
    const answer = page.locator('.msg-agent').last();
    const table = answer.locator('.cr-table');
    const number = new Intl.NumberFormat('es-MX');
    await expect(table.getByText(`${number.format(1248)} filas · 4 columnas`)).toBeVisible();
    const region = table.getByRole('region', { name: 'costo_por_cuenta' });
    await expect(region.locator('tbody tr')).toHaveCount(200);
    await expect(
      table.getByText(
        `Se muestran 200 de ${number.format(1248)} filas. Descarga el CSV para verlas todas.`,
      ),
    ).toBeVisible();
    const box = await region.boundingBox();
    expect(box?.height).toBeLessThanOrEqual(301);
    // The header stays while the rows scroll (the large figure card is above: bring it in view).
    await region.scrollIntoViewIfNeeded();
    await region.evaluate((node: { scrollTop: number }) => {
      node.scrollTop = 2000;
    });
    await expect(region.getByRole('columnheader', { name: 'costo_usd' })).toBeInViewport();
    const csv = table.locator('.cr-file.is-compact', { hasText: 'costo_por_cuenta.csv' });
    await expect(csv.getByRole('button', { name: /Descargar/ })).toBeVisible({ timeout: 10_000 });
    // The CSV is the table's card, not a card of its own after it.
    await expect(answer.locator('.cr-file:not(.is-compact)', { hasText: '.csv' })).toHaveCount(0);
  });

  test('lines, a pie and points', async () => {
    let answer = await ask('analiza con código una gráfica de línea');
    await expect(answer.locator('.cr-chart svg.cr-svg polyline')).toHaveCount(3, {
      timeout: 10_000,
    });
    answer = await ask('analiza con código una gráfica de tarta');
    const pie = answer.locator('.cr-chart', { hasText: 'Reparto del costo de octubre' });
    await expect(pie.locator('.cr-plot.is-pie svg path')).toHaveCount(4, { timeout: 10_000 });
    await expect(pie.locator('.cr-legend.is-col li').first()).toContainText('EC2');
    await expect(pie.locator('.cr-legend.is-col li').first()).toContainText('66 %');
    answer = await ask('analiza con código una gráfica de dispersión');
    const scatter = answer.locator('.cr-chart', { hasText: 'Uso contra costo por instancia' });
    await expect(scatter.locator('svg.cr-svg circle')).toHaveCount(42, {
      timeout: 10_000,
    });
  });

  test('horizontal bars with long names, and a line of 120 days', async () => {
    let answer = await ask('analiza con código unas barras horizontales');
    const bars = answer.locator('.cr-chart', { hasText: 'Costo por servicio de AWS' });
    await expect(bars.locator('svg.cr-svg rect[rx="2"]')).toHaveCount(16, { timeout: 10_000 });
    await expect(bars.getByText('Amazon Relational Database Se…')).toBeVisible();
    answer = await ask('analiza con código muchas categorías');
    const days = answer.locator('.cr-chart', { hasText: 'Costo diario por servicio' });
    await expect(days.locator('svg.cr-svg polyline')).toHaveCount(3, { timeout: 10_000 });
    // Over 60 categories, no points but the active one.
    await expect(days.locator('svg.cr-svg circle')).toHaveCount(0);
    await days.getByRole('application').focus();
    // Focus may already take the first point (design): Home makes it the first either way.
    await page.keyboard.press('Home');
    await page.keyboard.press('PageDown');
    await expect(days.locator('.cr-hover')).toContainText('13 de 120');
  });

  test('a chart that cannot be drawn, one the guardrail withheld, and «Reintentar»', async () => {
    let answer = await ask('analiza con código una gráfica inválida');
    await expect(answer.getByText('No se pudo dibujar esta gráfica.')).toBeVisible({
      timeout: 10_000,
    });
    answer = await ask('analiza con código una gráfica retenida');
    await expect(
      answer.getByText('Mango no muestra esta gráfica: infringía una regla de seguridad.'),
    ).toBeVisible({ timeout: 10_000 });
    answer = await ask('analiza con código; la gráfica falla');
    await answer
      .locator('.cr-chart')
      .getByRole('button', { name: /Reintentar/ })
      .click({ timeout: 10_000 });
    await expect(answer.locator('.cr-chart svg.cr-svg rect[rx="2"]')).toHaveCount(18, {
      timeout: 10_000,
    });
  });

  test('a ```mango-chart``` block of the text is drawn where the agent wrote it', async () => {
    const answer = await ask('analiza con código, con la gráfica en el texto');
    const chart = answer.locator('.md .cr-chart', { hasText: 'Costo de EC2' });
    await expect(chart.locator('svg.cr-svg polyline')).toHaveCount(1, { timeout: 10_000 });
    await expect(answer.locator('.md pre')).toHaveCount(0);
  });

  test('the console stays clean', () => {
    const unexpected = consoleErrors.filter(
      (text) => !EXPECTED_NETWORK.some((pattern) => pattern.test(text)),
    );
    expect(unexpected).toEqual([]);
  });
});
