import { expect, test, type Page } from '@playwright/test';

// Skills (D92) against the local mock (`mock/skills.ts`). The app keeps its tokens in memory
// only, so every step navigates inside the SPA. The mock keeps its state across tests: each
// test writes something of its own.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

function row(page: Page, name: string) {
  return page.locator('button.sk-tr', { hasText: name });
}

test.describe.configure({ mode: 'serial' });

test.describe('Skills: catalog, detail, requests and editor', () => {
  let page: Page;
  const consoleErrors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await signIn(page);
    const link = page.getByRole('link', { name: 'Skills', exact: true }).first();
    if (!(await link.isVisible())) await page.getByRole('button', { name: 'Construir' }).click();
    await link.click();
    await expect(page).toHaveURL(/\/skills$/);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('lists the skills, their states and names as text', async () => {
    await expect(page.getByRole('heading', { level: 1, name: 'Skills' })).toBeVisible();
    await expect(row(page, 'Revisión de costos')).toContainText('v4 en aprobación');
    await expect(row(page, 'Conciliación de facturas')).toHaveClass(/is-warn/);
    await expect(row(page, 'Rightsizing <b>EC2</b>')).toContainText('Escritura');
    await expect(page.locator('main img, main b')).toHaveCount(0);
    await expect(page.getByText('Skills nuevas en aprobación')).toBeVisible();
  });

  test('the detail renders instructions as text and compares a new version', async () => {
    await row(page, 'Rightsizing <b>EC2</b>').click();
    let panel = page.getByRole('dialog', { name: 'Rightsizing <b>EC2</b>' });
    await expect(panel.locator('pre.sk-ins')).toContainText('<script>alert(1)</script>');
    await expect(panel.locator('pre.sk-ins mark')).toHaveText('{{cuenta}}');
    await expect(panel.locator('script')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Cerrar' }).click();

    await row(page, 'Revisión de costos').click();
    panel = page.getByRole('dialog', { name: 'Revisión de costos' });
    await expect(panel.getByText('Agentes que la usan · 2')).toBeVisible();
    await expect(panel.getByRole('button', { name: /Nueva versión/ })).toBeDisabled();
    await panel.getByRole('button', { name: 'Comparar con v3' }).click();
    await expect(panel.locator('pre.sk-diff .is-add').first()).toContainText('servicio y cuenta');
    await panel.getByRole('button', { name: 'Aprobar' }).click();
    await expect(page.getByText('Versión aprobada')).toBeVisible();
    await expect(panel).toContainText('FinOps · v4');
    await expect(panel.getByRole('button', { name: /Nueva versión/ })).toBeEnabled();
    await panel.getByRole('button', { name: 'Cerrar' }).click();
  });

  test('proposes a new skill, which waits for another administrator', async () => {
    await page.getByRole('button', { name: 'Nueva skill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nueva skill' });
    await dialog.getByLabel('Nombre').fill('Ahorro en Savings Plans');
    await dialog.getByLabel('Instrucciones').fill('Revisa la cobertura de {{cuenta}}.');
    await expect(dialog.locator('code.mc-tool-chip')).toHaveText('cuenta');
    // Other specs enable and disable servers of the shared mock: any enabled one will do.
    const servers = dialog.locator('.sk-servers button.ab-item');
    await expect(servers.first()).toBeVisible();
    expect(await servers.and(page.locator(':disabled')).count()).toBeGreaterThan(0);
    await servers.and(page.locator(':enabled')).first().click();
    await dialog.getByRole('textbox', { name: 'Motivo' }).fill('Lo pide FinOps');
    await dialog.getByRole('button', { name: 'Enviar a aprobación' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Enviada a aprobación/)).toBeVisible();
    const card = page.locator('article.chg', { hasText: 'Nueva skill Ahorro en Savings Plans' });
    await expect(card).toContainText('Tu propuesta');
    await expect(card.getByRole('button', { name: 'Retirar' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Aprobar' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Retirar' }).click();
    await expect(card).toContainText('Retirado');
  });

  test('rejects a new skill of another person with a reason', async () => {
    const card = page.locator('article.chg', { hasText: 'Nueva skill Salud de servicios' });
    await card.getByRole('button', { name: 'Rechazar' }).click();
    await card.getByRole('textbox', { name: 'Motivo del rechazo' }).fill('Ya existe en Bedrock');
    await card.getByRole('button', { name: 'Rechazar' }).last().click();
    await expect(card).toContainText('Rechazado');
    await expect(card).toContainText('Ya existe en Bedrock');
    expect(consoleErrors).toEqual([]);
  });

  test('fits a phone: no horizontal scroll', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row(page, 'Precios de instancias')).toBeVisible();
    const overflow = await page.evaluate<number>(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    expect(overflow).toBe(0);
  });
});
