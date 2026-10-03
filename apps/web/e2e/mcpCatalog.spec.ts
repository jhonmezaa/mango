import { expect, test, type Page } from '@playwright/test';

// Marketplace v1, phase B: the MCP catalog against the local mock (`mock/mcpCatalog.ts`). The
// app keeps its tokens in memory only, so every step navigates inside the SPA.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

function row(page: Page, name: string) {
  return page.locator('button.mc-tr', { hasText: name });
}

test.describe.configure({ mode: 'serial' });

test.describe('MCP catalog: request, approve and disable a pack', () => {
  let page: Page;
  const consoleErrors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await signIn(page);
    const link = page.getByRole('link', { name: 'Catálogo de MCP', exact: true }).first();
    // The "Construir" group of the sidebar may be collapsed.
    if (!(await link.isVisible())) await page.getByRole('button', { name: 'Construir' }).click();
    await link.click();
    await expect(page).toHaveURL(/\/mcp$/);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('lists connectors and packs; what has no backend says so', async () => {
    await expect(page.getByRole('heading', { level: 1, name: 'Catálogo de MCP' })).toBeVisible();
    await expect(row(page, 'AWS Cost Explorer')).toContainText('Conector de Mango');
    await expect(row(page, 'AWS Pricing')).toContainText('Habilitado');
    // Health has no data yet; account data says how it is reached.
    await expect(row(page, 'AWS Pricing')).toContainText('Próximamente');
    await expect(row(page, 'AWS Cost Explorer')).toContainText('Por usuario');
    await expect(row(page, 'AWS Billing')).toContainText('Solo centrales');
    await expect(
      page.getByRole('button', { name: 'Conectar MCP por URL, próximamente' }),
    ).toBeDisabled();
  });

  test('a request of another admin shows what it adds and its text as text', async () => {
    await page.getByRole('tab', { name: /Solicitudes pendientes/ }).click();
    const panel = page.getByRole('tabpanel');
    await expect(panel).toContainText('esperan tu aprobación · 3');
    await expect(panel).toContainText(
      '“FinOps central necesita conciliar facturas <b>sin salir</b>',
    );
    await panel
      .locator('.mc-req', { hasText: 'AWS Billing' })
      .getByRole('button', { name: 'Revisar' })
      .click();

    const detail = page.getByRole('dialog', { name: 'AWS Billing' });
    await expect(detail).toContainText('Antes de aprobar');
    await expect(detail).toContainText('Suma 3 permisos de AWS nuevos');
    await expect(detail.locator('b', { hasText: 'sin salir' })).toHaveCount(0);
  });

  test('approving installs the pack: the catalog follows the platform', async () => {
    const detail = page.getByRole('dialog', { name: 'AWS Billing' });
    await detail.getByRole('button', { name: 'Aprobar e instalar' }).click();
    await expect(page.getByText('Aprobado · instalando AWS Billing')).toBeVisible();
    await expect(detail.getByRole('status')).toContainText('Instalando');
    // No reload: the page reads the catalog again until the installation ends.
    await expect(detail.getByRole('button', { name: 'Deshabilitar' })).toBeVisible({
      timeout: 20_000,
    });
    // Enabled: the tools that depend on an opt-in AWS service say so, without claiming its state.
    await expect(detail).toContainText('Solo usuarios centrales');
    await expect(detail).toContainText(
      'Compute Optimizer y Cost Optimization Hub se activan aparte en la cuenta pagadora',
    );
    await expect(detail).toContainText('Requiere Compute Optimizer');
    await detail.getByRole('button', { name: 'Cerrar' }).click();
    await page.getByRole('tab', { name: /^Catálogo/ }).click();
    await expect(row(page, 'AWS Billing')).toContainText('Habilitado');
  });

  test('the requester cannot approve their own request, and can withdraw it', async () => {
    await row(page, 'AWS Documentation').click();
    const detail = page.getByRole('dialog', { name: 'AWS Documentation' });
    await detail.getByRole('button', { name: 'Solicitar habilitación' }).click();
    await detail.getByLabel(/Para qué se necesita/).fill('Consultar guías de servicio');
    await detail.getByRole('button', { name: 'Enviar solicitud' }).click();
    await expect(
      page.getByText('Solicitud enviada · otro administrador debe aprobarla'),
    ).toBeVisible();
    await expect(detail).toContainText(
      'Tú pediste habilitarlo: lo debe aprobar otro administrador.',
    );
    await expect(detail.getByRole('button', { name: 'Aprobar e instalar' })).toHaveCount(0);
    await expect(row(page, 'AWS Documentation')).toContainText('Pendiente de aprobación');
    await detail.getByRole('button', { name: 'Retirar solicitud' }).click();
    await expect(page.getByText('Solicitud retirada')).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Solicitar habilitación' })).toBeVisible();
    await detail.getByRole('button', { name: 'Cerrar' }).click();
    await expect(row(page, 'AWS Documentation')).toContainText('Disponible');
  });

  test('disabling needs a reason and names the affected agents', async () => {
    await row(page, 'AWS Pricing').click();
    const detail = page.getByRole('dialog', { name: 'AWS Pricing' });
    await detail.getByRole('button', { name: 'Deshabilitar' }).click();
    await expect(detail).toContainText(
      '1 agente publicado con tools no disponibles: Savings Plans',
    );
    await detail.getByRole('button', { name: 'Deshabilitar' }).click();
    await expect(detail.getByRole('alert')).toContainText('El motivo es obligatorio');
    await detail.getByLabel('Motivo para deshabilitar').fill('Prueba de extremo a extremo');
    await detail.getByRole('button', { name: 'Deshabilitar' }).click();
    await expect(page.getByText('AWS Pricing deshabilitado')).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Solicitar habilitación' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(detail).toContainText('Savings PlansTools no disponibles');
    await detail.getByRole('button', { name: 'Cerrar' }).click();
  });

  test('the Agent Builder no longer offers the tools of the disabled pack', async () => {
    await page.getByRole('link', { name: 'Marketplace', exact: true }).first().click();
    await page.getByRole('link', { name: 'Nuevo agente' }).click();
    await expect(page.getByRole('button', { name: /^get_cost_and_usage/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^get_products/ })).toHaveCount(0);
    // Enabled a moment ago by the approval above.
    await expect(page.getByRole('button', { name: /^list_invoices/ })).toBeVisible();
  });

  test('nothing failed in the browser console', () => {
    expect(consoleErrors).toEqual([]);
  });
});
