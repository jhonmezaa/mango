import { expect, test, type Page } from '@playwright/test';

// Servicios externos (D93, D98; design remote-views.jsx) against the local mock
// (`mock/remoteMcp.ts`): the Bandeja pins the request of another administrator, the catalog
// approves it and asks for another one in two steps, and Ajustes › Conectividad lists them.
// The app keeps its tokens in memory only, so every step navigates inside the SPA.

const SECRET = 'e2e-secret-value-never-shown';

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.describe('remote MCP services: approve, ask and see them in Conectividad', () => {
  let page: Page;
  const consoleErrors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await signIn(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('the Bandeja pins the request of another administrator and opens it', async () => {
    await page
      .getByRole('link', { name: /^Bandeja/ })
      .first()
      .click();
    const notices = page.getByRole('listbox', { name: 'Avisos' });
    await notices
      .getByRole('option', { name: /Te piden aprobar: Azure DevOps para empresa-labs/ })
      .click();
    await page.getByRole('button', { name: /Revisar la solicitud/ }).click();
    await expect(page).toHaveURL(/\/mcp\/remote\/azure-devops\/[a-z2-7]{12}$/);
    const drawer = page.getByRole('dialog', { name: 'Azure DevOps · empresa-labs' });
    await expect(drawer).toContainText('2 · Otra persona administradora aprueba');
    await expect(drawer).toContainText('bedrock-agentcore.us-east-1.amazonaws.com');
  });

  test('approving creates it, and the catalog follows until it is enabled', async () => {
    const drawer = page.getByRole('dialog', { name: 'Azure DevOps · empresa-labs' });
    await drawer.getByRole('button', { name: 'Aprobar' }).click();
    await expect(drawer.getByText('Creándose.')).toBeVisible();
    // The mock provisioner finishes in a few seconds; the page reads again every 5 s.
    await expect(drawer.getByText('Habilitado', { exact: true })).toBeVisible({ timeout: 20_000 });
    await drawer.getByRole('button', { name: 'Cerrar' }).click();
  });

  test('asks for a new organization in two steps, and the secret never shows', async () => {
    await page.getByRole('button', { name: /^Azure DevOps/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Azure DevOps' });
    await expect(drawer).toContainText('.default (delegado, lectura)');
    await drawer.getByRole('button', { name: /Habilitar para una organización/ }).click();
    await drawer.getByLabel('Organización de Azure DevOps').fill('fabrikam');
    await drawer
      .getByLabel('Tenant de Entra (tenantId)')
      .fill('00000000-0000-4000-8000-000000000011');
    await drawer.getByLabel('Id de la app (clientId)').fill('00000000-0000-4000-8000-000000000012');
    await drawer.getByLabel('Secreto de la app').fill(SECRET);
    await drawer.getByRole('button', { name: 'finops-central' }).click();
    await drawer.getByRole('button', { name: 'Enviar solicitud' }).click();
    await expect(drawer.getByText('Solicitud enviada.')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Copiar' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Retirar solicitud' })).toBeVisible();
    expect(await page.content()).not.toContain(SECRET);
    await drawer.getByRole('button', { name: 'Cerrar' }).click();
  });

  test('Ajustes › Conectividad lists the services with the secret and the request', async () => {
    await page.getByRole('button', { name: 'Ajustes', exact: true }).first().click();
    await page.getByRole('tab', { name: 'Conectividad' }).click();
    await expect(page.getByRole('heading', { name: 'Servicios externos' })).toBeVisible();
    await expect(page.getByText('mcp.dev.azure.com/empresa', { exact: true })).toBeVisible();
    // The mock dates the secret in UTC when it starts: a run that crosses midnight sees 20
    // days, and one in the local evening, when UTC is already the next day, sees 22.
    await expect(page.getByText(/Vence el .* · en 2[0-2] días/)).toBeVisible();
    await expect(page.getByRole('button', { name: /1 solicitud pendiente/ })).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });
});
