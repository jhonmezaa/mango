import { expect, test, type Page } from '@playwright/test';

// Actividad (D90, design round 19 «Disponible hoy») against the local mock, as an administrator:
// the KPIs, someone else's turn without its conversation, one's own conversation opening from its
// row, the filters and a phone width without horizontal scroll. The app keeps its tokens in
// memory only, so every step navigates inside the SPA.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function openActivity(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  const link = nav.getByRole('link', { name: 'Actividad', exact: true });
  if (!(await link.isVisible())) await nav.getByRole('button', { name: 'Gobernanza' }).click();
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Actividad' })).toBeVisible();
}

test('Actividad shows everyone’s activity to an administrator, metadata only', async ({ page }) => {
  await signIn(page);
  await openActivity(page);
  await expect(page.getByText(/chats y las tareas de todos/)).toBeVisible();
  await expect(page.getByText('Agentes con actividad', { exact: true })).toBeVisible();
  await expect(page.getByText(/de \d+ publicados/)).toBeVisible();
  await expect(page.getByText('agentes más activos', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /En vivo/ })).toBeVisible();

  // The turn blocked by the agent's budget, and someone else's call with its latency.
  await page.getByRole('button', { name: '7 días' }).click();
  await expect(page.getByText(/no respondió: se agotó el presupuesto/)).toBeVisible();
  await expect(
    page.getByText('Aquí se ven hasta 7 días. La actividad se guarda 30 días.'),
  ).toBeVisible();

  // Errors only: someone else's failed call, with nothing to open.
  await page
    .getByRole('group', { name: 'Tipo' })
    .getByRole('button', { name: /Errores/ })
    .click();
  await page.locator('.ac-main').first().click();
  await expect(
    page.getByText('De otra persona: solo ves el agente, la tool y la hora.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Abrir conversación/ })).toHaveCount(0);
});

test('Actividad opens one’s own conversation from its row', async ({ page }) => {
  await signIn(page);
  await openActivity(page);
  await page.getByRole('button', { name: '7 días' }).click();
  await page.getByLabel('Buscar actividad').fill('get_cost_forecast');
  const own = page.locator('.ac-main').first();
  await own.click();
  await page
    .getByRole('button', { name: /Abrir conversación/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/c\/[A-Za-z0-9_-]+$/);
});

test('Actividad fits a phone width', async ({ page }) => {
  await signIn(page);
  await openActivity(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Tools con error', { exact: true })).toBeVisible();
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  );
  expect(overflow).toBe(0);
});
