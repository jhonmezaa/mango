import { expect, test, type Page } from '@playwright/test';

// Inicio (D102, design dashboard.jsx) against the local mock, as an administrator: spend and
// invocations of the period, another period, the comparison, the budgets, the approvals notice
// and a phone width without horizontal scroll. The app keeps its tokens in memory only, so every
// step navigates inside the SPA.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function openHome(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  await nav.getByRole('link', { name: 'Inicio', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Gasto en Bedrock' })).toBeVisible();
}

test('Inicio shows the period, changes it and keeps «Próximamente» without a source', async ({
  page,
}) => {
  await signIn(page);
  await openHome(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Buen(os|as) /);
  await expect(page.getByRole('heading', { name: 'Invocaciones' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Gasto en Bedrock' })).toBeVisible();
  await expect(page.getByText(/periodo anterior$/).first()).toBeVisible();
  for (const title of ['Estado de agentes', 'Tickets resueltos', 'Latencia p95']) {
    await expect(page.getByText(`${title}, próximamente`)).toBeAttached();
  }
  await expect(page.getByRole('heading', { name: 'Presupuestos cerca del límite' })).toBeVisible();

  const answer = page.waitForResponse((r) => r.url().includes('/home?period=7d'));
  await page.getByRole('button', { name: /^Periodo/ }).click();
  await page.getByRole('option', { name: 'Últimos 7 días' }).click();
  expect((await answer).status()).toBe(200);
  await expect(page.getByRole('button', { name: /^Periodo/ })).toContainText('Últimos 7 días');

  await page.getByRole('button', { name: 'Quitar Comparar' }).click();
  await expect(page.getByText(/periodo anterior$/)).toHaveCount(0);
  await page.getByRole('button', { name: '+ Comparar' }).click();
  await expect(page.getByText(/periodo anterior$/).first()).toBeVisible();

  await page.getByRole('button', { name: 'Ver presupuestos' }).click();
  await expect(page).toHaveURL(/\/budgets$/);
});

test('Inicio fits a phone width', async ({ page }) => {
  await signIn(page);
  await openHome(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Invocaciones' })).toBeVisible();
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
