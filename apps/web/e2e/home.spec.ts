import { expect, test, type Page } from '@playwright/test';

// Inicio (D102, design dashboard.jsx) against the local mock, as an administrator: spend and
// invocations of the period, another period, the comparison, the budgets, the approvals notice,
// the scope and the first day the server answers, and a phone width without horizontal scroll. The app keeps its tokens in memory only, so every
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
  await expect(page.getByRole('heading', { name: /^Gasto en Bedrock/ })).toBeVisible();
}

test('Inicio shows the period, changes it and hides what has no source', async ({ page }) => {
  await signIn(page);
  await openHome(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Buen(os|as) /);
  await expect(page.getByRole('heading', { name: /^Invocaciones/ })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Gasto en Bedrock' })).toBeVisible();
  await expect(page.getByText(/periodo anterior$/).first()).toBeVisible();
  for (const title of ['Estado de agentes', 'Tickets resueltos', 'Latencia p95']) {
    await expect(page.getByText(title)).toHaveCount(0);
  }
  await expect(page.getByText('Ver detalles')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^Presupuestos cerca del límite/ })).toBeVisible();

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

test('Inicio follows the scope of the answer and the day the counter started', async ({ page }) => {
  await page.route('**/api/home?*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { days: { day: string }[] };
    await route.fulfill({
      response,
      json: {
        ...body,
        scope: 'mine',
        counted_since: body.days[body.days.length - 12]?.day,
        budgets_scope: 'mine',
        budgets: [
          {
            scope: 'user',
            id: 'u-1',
            name: 'nombre@empresa.com',
            spent_usd: '3.20',
            limit_usd: '20.00',
          },
        ],
      },
    });
  });
  await signIn(page);
  await openHome(page);
  await expect(page.getByText('Así va tu uso de Mango en el periodo seleccionado.')).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Tu presupuesto/ })).toBeVisible();
  await expect(page.getByText('Límite personal')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ver presupuestos' })).toHaveCount(0);
  await expect(page.getByText(/^Cuenta desde el /).first()).toBeVisible();
  await expect(page.getByText(/periodo anterior$/)).toHaveCount(0);
  await expect(page.getByText('Sin datos').first()).toBeAttached();
  const chart = page.getByRole('img', { name: /^Gasto en Bedrock · cuenta desde el / });
  const box = await chart.boundingBox();
  if (!box) throw new Error('no chart');
  await page.mouse.move(box.x + 20, box.y + 60);
  await expect(page.getByRole('tooltip')).toContainText('no es que no hubiera gasto');
});

test('Inicio says it could not load in its own card', async ({ page }) => {
  await page.route('**/api/home?*', (route) =>
    route.fulfill({ status: 503, json: { code: 'home_unavailable', message: 'please try again' } }),
  );
  await signIn(page);
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  await nav.getByRole('link', { name: 'Inicio', exact: true }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('No se pudo cargar Inicio');
  await page.unroute('**/api/home?*');
  await alert.getByRole('button', { name: 'Reintentar' }).click();
  await expect(page.getByRole('heading', { name: /^Gasto en Bedrock/ })).toBeVisible();
});

test('Inicio fits a phone width', async ({ page }) => {
  await signIn(page);
  await openHome(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: /^Invocaciones/ })).toBeVisible();
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
