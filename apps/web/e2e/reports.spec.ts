import { expect, test, type Page } from '@playwright/test';

// Downloadable reports of task runs (D86) against the local mock: «Cierre mensual de costos»
// has two PDFs ready and one that could not be drawn. The download asks the API for a new link
// and the browser downloads it as an attachment; the link is never shown.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function openClosing(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  // Schedules lives in the «Construir» group of the sidebar, closed by default.
  await nav.getByRole('button', { name: 'Construir' }).click();
  await nav.getByRole('link', { name: 'Schedules' }).click();
  await page.getByText('Cierre mensual de costos', { exact: true }).first().click();
  await expect(page.getByText('PDF · Resumen de costos · solo tú lo descargas')).toBeVisible();
}

test('the owner downloads the PDF of a run with a new link', async ({ page }) => {
  // The mock's link is neutral: here it answers a PDF as an attachment.
  await page.route('https://reports.example/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      headers: { 'Content-Disposition': 'attachment; filename="reporte.pdf"' },
      body: '%PDF-1.4\n%%EOF\n',
    }),
  );
  await signIn(page);
  await openClosing(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar PDF' }).first().click();
  expect((await download).suggestedFilename()).toBe('reporte.pdf');
  await expect(page.getByText(/reports\.example/)).toHaveCount(0);
});

test('a PDF that could not be drawn is generated again without running the agent', async ({
  page,
}) => {
  await signIn(page);
  await openClosing(page);
  await expect(page.getByText('No se generó el PDF')).toBeVisible();
  // The third run (the oldest) is the one whose PDF failed.
  await page.getByRole('button', { name: 'Ver resultado' }).nth(2).click();
  await expect(page.getByText('No se pudo generar el PDF · Resumen de costos')).toBeVisible();
  await page.getByRole('button', { name: 'Generar de nuevo' }).click();
  await expect(page.getByText('Generando el PDF · Resumen de costos')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Descargar', exact: true })).toBeVisible({
    timeout: 15_000,
  });
});
