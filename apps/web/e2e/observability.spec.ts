import { expect, test, type Page } from '@playwright/test';

// Observability (D108, D109, design round 37) against the local mock (`mock/observability.ts`), as
// an administrator: the KPIs and the fixed notice of metadata only, a row and its drawer with
// «Copiar ID», the search in the server, the cap of a reading («al menos») and a phone width
// without horizontal scroll. The app keeps its tokens in memory only, so every step navigates
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

async function openObservability(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  const link = nav.getByRole('link', { name: 'Observability', exact: true });
  if (!(await link.isVisible())) await nav.getByRole('button', { name: 'Operación' }).click();
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Observability' })).toBeVisible();
}

test('Observability shows the traces of the range to an administrator, metadata only', async ({
  page,
}) => {
  await signIn(page);
  await openObservability(page);
  await expect(page.getByText('Trazas', { exact: true })).toBeVisible();
  await expect(page.getByText(/k tokens · sin el guardrail/)).toBeVisible();
  await expect(page.getByText('trazas por hora · 24 h')).toBeVisible();
  await expect(page.getByText('latencia por agente · p95')).toBeVisible();
  await expect(page.getByText(/^Conversación de usuario\d@empresa\.com$/).first()).toBeVisible();
  await expect(page.getByText('Sin turno de Mango').first()).toBeVisible();
  // Design round 38: no «Con aprobación» chip while a turn carries no such mark.
  await expect(page.getByText('Con aprobación')).toHaveCount(0);
  await shot(page, 'observability-24h');

  // A row opens its drawer: the short id, the fixed notice and «Copiar ID» of the whole id.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const row = page.locator('button.ob-tr').first();
  const short = (await row.locator('.ob-tr-id').innerText()).split(' · ')[0] ?? '';
  await row.click();
  const drawer = page.getByRole('dialog', { name: `Traza ${short}` });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/^Solo metadatos: tipo de llamada/)).toBeVisible();
  await expect(drawer.getByText(/^Modelo · us\.anthropic\./).first()).toBeVisible();
  // The e2e code has no DOM types: the page runs these expressions as text.
  await page.evaluate(
    "Promise.all(document.querySelector('.ob-drawer').getAnimations().map((a) => a.finished)).then(() => true)",
  );
  await shot(page, 'observability-drawer');
  await drawer.getByRole('button', { name: 'Copiar ID' }).click();
  await expect(page.getByText('ID copiado')).toBeVisible();
  const copied = await page.evaluate<string>('navigator.clipboard.readText()');
  expect(copied).toMatch(/^[0-9a-f]{32}$/);
  expect(copied.startsWith(short)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // The search goes to the server: by the id copied, only that trace.
  const asked = page.waitForRequest(
    (request) =>
      request.url().includes(`/api/observability?`) && request.url().includes(`q=${copied}`),
  );
  await page.getByLabel('Buscar trazas').fill(copied);
  await asked;
  await expect(page.locator('button.ob-tr')).toHaveCount(1);
  await page.getByLabel('Buscar trazas').fill('nadie-coincide');
  await expect(page.getByText('Ninguna traza coincide.')).toBeVisible();
});

test('Observability says when the reading reached its cap', async ({ page }) => {
  await page.route('**/api/observability?*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, capped: true } });
  });
  await signIn(page);
  await openObservability(page);
  await expect(page.getByText(/^al menos \d/).first()).toBeVisible();
  await expect(
    page.getByText(/La lectura se detuvo en \d+ trazas: las cifras son un mínimo\./),
  ).toBeVisible();
  await shot(page, 'observability-cap');
});

test('Observability fits a phone width', async ({ page }) => {
  await signIn(page);
  await openObservability(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('button.ob-tr').first()).toBeVisible();
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, 'observability-phone');
});
