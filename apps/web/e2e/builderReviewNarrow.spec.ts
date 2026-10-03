import { expect, test, type Page } from '@playwright/test';

// Agent Builder and agent review on a phone (Claude Design, October 2026 round), against the
// local mock. The app keeps its tokens in memory only, so every step navigates inside the SPA.

/** Agent of another administrator that waits for review in the mock (`mock/agents.ts`). */
const OTHERS_AGENT = 'Anomalías <b>Retail</b>';

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

const PHONE = { width: 420, height: 900 };

/** Opens a section from the sidebar at desktop width, then turns the window into a phone. */
async function openOnPhone(page: Page, ...links: string[]): Promise<void> {
  for (const name of links) {
    await page.getByRole('link', { name, exact: true }).first().click();
  }
  await page.setViewportSize(PHONE);
}

test('the Builder bar keeps «Enviar» and moves the rest to a menu', async ({ page }) => {
  await signIn(page);
  await openOnPhone(page, 'Marketplace', 'Nuevo agente');
  await expect(page.getByRole('heading', { name: 'Nuevo agente' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Guardar borrador' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Más acciones' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Guardar borrador', 'Cancelar']);
  await page.getByRole('menuitem', { name: 'Guardar borrador' }).click();
  await expect(page.getByRole('alert')).toContainText('No se pudo guardar');

  // New fields of the round.
  await expect(page.getByRole('group', { name: 'Tokens por llamada' })).toBeVisible();
  await expect(page.getByLabel('Temperatura')).toBeVisible();
  await expect(page.getByPlaceholder('correo@empresa.com')).toBeEnabled();
});

test('the review queue takes the whole width and a row opens the detail', async ({ page }) => {
  await signIn(page);
  await openOnPhone(page, 'Revisión de agentes');
  const queue = page.getByRole('listbox', { name: 'Agentes en revisión' });
  await expect(queue).toBeVisible();
  const detail = page.getByRole('region', { name: 'Detalle de la revisión' });
  await expect(detail).toHaveCount(0);

  await queue.getByRole('option', { name: new RegExp(OTHERS_AGENT) }).click();
  await expect(detail.getByRole('heading', { level: 2, name: OTHERS_AGENT })).toBeVisible();
  await expect(queue).toBeHidden();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
  // The decision stays in view at the bottom while the diff scrolls.
  await expect(detail.getByRole('button', { name: 'Aprobar y publicar' })).toBeInViewport();
  // Creator text is text: no element is created from it.
  expect(await detail.locator('script, img').count()).toBe(0);

  await detail.getByRole('button', { name: 'Volver a la cola' }).click();
  await expect(queue).toBeVisible();
  await expect(detail).toHaveCount(0);

  // History as stacked rows, each value with its label.
  await page.getByRole('tab', { name: 'Historial' }).click();
  const table = page.getByRole('table', { name: 'Historial de revisiones' });
  await expect(table.getByRole('columnheader').first()).toBeHidden();
  await expect(table.getByRole('row').nth(1)).toBeVisible();
});
