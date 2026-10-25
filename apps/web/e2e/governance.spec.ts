import { expect, test, type Page } from '@playwright/test';

// Gobernanza (D89, design round 19 «Disponible hoy») against the local mock, as an administrator:
// what needs attention, the indicators, the policies by tool and the recent activity, opening
// Ajustes › Áreas from its row, and a phone width without horizontal scroll. The app keeps its
// tokens in memory only, so every step navigates inside the SPA.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function openGovernance(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  const link = nav.getByRole('link', { name: 'Gobernanza', exact: true });
  if (!(await link.isVisible())) await nav.getByRole('button', { name: 'Gobernanza' }).click();
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Gobernanza' })).toBeVisible();
}

test('Gobernanza shows the summary and opens Ajustes on Áreas', async ({ page }) => {
  await signIn(page);
  await openGovernance(page);
  await expect(page.getByText('necesita atención', { exact: true })).toBeVisible();
  await expect(page.getByText('Aprobaciones pendientes', { exact: true })).toBeVisible();
  await expect(page.getByText('Decisiones · 7 días', { exact: true })).toBeVisible();
  await expect(page.getByText('Eventos auditados · 24 h', { exact: true })).toBeVisible();
  await expect(page.getByText('Sin lecturas · con hash y Object Lock en S3')).toBeVisible();
  await expect(page.getByText('políticas que piden aprobación', { exact: true })).toBeVisible();
  await expect(page.getByText('actividad reciente', { exact: true })).toBeVisible();
  await expect(page.getByText('Gasto de equipos')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Audit log/ })).toBeVisible();

  const areas = page.getByRole('button', { name: /cambios? de áreas pendientes?/ });
  await expect(areas).toBeVisible();
  await areas.click();
  await expect(page).toHaveURL(/\/settings\/areas$/);
  await expect(page.getByRole('tab', { name: /Áreas/ })).toHaveAttribute('aria-selected', 'true');
});

test('Gobernanza fits a phone width', async ({ page }) => {
  await signIn(page);
  await openGovernance(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Aprobaciones pendientes', { exact: true })).toBeVisible();
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  );
  expect(overflow).toBe(0);
});
