import { expect, test, type Page } from '@playwright/test';

// Costos (D105–D107, design round 37 costs2.jsx) against the local mock, as an administrator:
// the month, the breakdowns with the day each one counts from and what came before, the agent's
// drawer with its budget, «Próximamente» where there is no source, the CSV, and a phone width
// without horizontal scroll. The app keeps its tokens in memory only: every step stays in the SPA.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function openCosts(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  const link = nav.getByRole('link', { name: 'Costos', exact: true });
  if (!(await link.isVisible())) await nav.getByRole('button', { name: 'Operación' }).click();
  await link.click();
  await expect(page.getByRole('heading', { name: 'Costos', level: 1 })).toBeVisible();
}

test('Costos shows the month and its breakdowns from the counters', async ({ page }) => {
  await signIn(page);
  await openCosts(page);
  await expect(page.getByText(/^Gasto en Amazon Bedrock de /)).toBeVisible();
  await expect(page.getByText(/^[\d.]+ consultas$/)).toBeVisible();
  await expect(page.getByRole('img', { name: /^Gasto acumulado: / })).toBeVisible();
  await expect(page.getByText('Sin agente', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Por equipo/ })).toBeDisabled();
  await expect(page.getByText('oportunidades de ahorro')).toBeVisible();

  await page.getByRole('button', { name: 'Por origen' }).click();
  await expect(page.getByText('Conversaciones', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Cuenta desde el /)).toBeVisible();
  await page.getByRole('button', { name: 'Por modelo' }).click();
  await expect(page.getByText('Sin desglose', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Antes del /)).toBeVisible();

  await page.getByRole('button', { name: 'Por agente' }).click();
  await page.locator('button.co-tr').first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Presupuesto', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Por origen')).toBeVisible();
  await expect(drawer.getByText('Próximamente')).toBeVisible();
  await drawer.getByRole('button', { name: 'Ver presupuestos' }).click();
  await expect(page).toHaveURL(/\/budgets$/);
});

test('Costos exports the CSV', async ({ page }) => {
  await signIn(page);
  await openCosts(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportar CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^mango-costos-\d{4}-\d{2}\.csv$/);
  await expect(page.getByText('Costos exportados')).toBeVisible();
});

test('Costos fits a phone without horizontal scroll', async ({ page }) => {
  await signIn(page);
  await openCosts(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Costos', level: 1 })).toBeVisible();
  const width = await page.evaluate<number>('document.documentElement.scrollWidth');
  expect(width).toBeLessThanOrEqual(390);
});

test('Costos says who sees it on a 403', async ({ page }) => {
  await page.route('**/api/costs*', (route) =>
    route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'forbidden' } } }),
  );
  await signIn(page);
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  const link = nav.getByRole('link', { name: 'Costos', exact: true });
  if (!(await link.isVisible())) await nav.getByRole('button', { name: 'Operación' }).click();
  await link.click();
  await expect(page.getByText('No tienes acceso a Costos')).toBeVisible();
  await page.getByRole('link', { name: 'Ir al chat' }).click();
  await expect(page).toHaveURL(/\/$/);
});
