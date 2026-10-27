import { expect, test, type Page } from '@playwright/test';

// A remote MCP in the chat (D93, D94, D98; design remote-core.jsx and remote-views.jsx) against
// the local mock (`mock/connections.ts`): the agent asks to connect Azure DevOps, «Conectar» leaves
// for AgentCore Identity, the provider sends the browser back to `/conexiones/vuelta` and the SPA
// closes the consent; the next answer reads the service and its links say where they go.
// The AgentCore host is answered here by Playwright: no request leaves the machine.

const AGENTCORE = 'https://bedrock-agentcore.us-east-1.amazonaws.com/**';
const SESSION = 'urn:ietf:params:oauth:request_uri:e2e-session';

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  // The session cookie (D63) is what survives the trip to the provider.
  const started = page.waitForResponse(
    (r) => r.url().endsWith('/api/session') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  expect((await started).status()).toBe(204);
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function ask(page: Page, text: string): Promise<void> {
  const composer = page.getByRole('textbox').last();
  await composer.fill(text);
  await composer.press('Enter');
}

test('the chat asks to connect a remote service, and the return closes the consent', async ({
  page,
  baseURL,
}) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.route(AGENTCORE, (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `${baseURL ?? ''}/conexiones/vuelta?session_id=${encodeURIComponent(SESSION)}`,
      },
    }),
  );
  await signIn(page);

  await ask(page, '¿Qué tiene abierto el sprint 42 de Plataforma?');
  const card = page.getByRole('region', { name: 'Aviso de Mango: conectar Azure DevOps' });
  await expect(card).toContainText('Conecta tu cuenta de Azure DevOps');
  await expect(card).toContainText('No lo escribió el agente');
  await expect(card).toContainText(/Vence en \d+:\d{2}/);

  const back = page.waitForURL(/\/conexiones\/vuelta$/);
  await card.getByRole('button', { name: /Conectar/ }).click();
  await back;
  await expect(
    page.getByRole('heading', { name: 'Listo, tu cuenta de Azure DevOps está conectada.' }),
  ).toBeVisible();
  // The session id never stays in the address bar or in Web Storage (P-9).
  expect(new URL(page.url()).search).toBe('');
  const stored = await page.evaluate<string>(
    'JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])',
  );
  expect(stored).not.toMatch(/request_uri|session_id|e2e-session/);

  await page.getByRole('button', { name: 'Volver al chat' }).click();
  await ask(page, 'Y ahora, ¿qué tiene abierto el sprint 42?');
  await expect(page.getByText('Encontré 3 work items abiertos')).toBeVisible();

  // Stored answers carry what they read («Leyó») and the links say where they go (A1).
  await page.reload();
  await expect(page.getByText('Leyó Azure DevOps')).toBeVisible();
  const wiki = page.getByRole('button', { name: 'wiki de Plataforma' });
  await expect(wiki).toHaveAttribute('data-host-kind', 'service');
  await page.getByRole('button', { name: 'el tablero' }).click();
  const dialog = page.getByRole('dialog', { name: 'Abrir enlace externo' });
  await expect(dialog).toContainText('Otra organización');
  await expect(dialog).toContainText('dev.azure.com/plataforma-tableros');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();

  // Mis conexiones says it is connected; «Desconectar» waits for the design (D97).
  await page.getByRole('button', { name: /^Cuenta de / }).click();
  await page.getByRole('menuitem', { name: 'Mis conexiones' }).click();
  const mine = page.getByRole('dialog', { name: 'Mis conexiones' });
  await expect(mine).toContainText('Conectado');
  await expect(mine).toContainText('Desconectar, próximamente');
  expect(consoleErrors).toEqual([]);
});

test('a return without a pending consent says the link expired', async ({ page }) => {
  await signIn(page);
  await page.goto(`/conexiones/vuelta?session_id=${encodeURIComponent(`${SESSION}-expired`)}`);
  await expect(page.getByRole('heading', { name: 'El enlace venció' })).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
});
