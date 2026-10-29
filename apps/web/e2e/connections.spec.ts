import { expect, test, type Page } from '@playwright/test';

// A remote MCP in the chat (D93, D94, D98; design remote-core.jsx and remote-views.jsx) against
// the local mock (`mock/connections.ts`): the agent asks to connect Azure DevOps, «Conectar» opens
// AgentCore Identity in another tab, the provider sends that tab back to `/conexiones/vuelta`, which
// hands the `session_id` to the chat's tab, and the chat's tab closes the consent with its own token
// (D100; the mock refuses any other token, like Identity). The next answer reads the service and
// its links say where they go.
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

test('the chat asks to connect a remote service, and its tab closes the consent', async ({
  page,
  context,
  baseURL,
}) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  // For every tab: the provider's tab is a new one.
  await context.route(AGENTCORE, (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `${baseURL ?? ''}/conexiones/vuelta?session_id=${encodeURIComponent(SESSION)}`,
      },
    }),
  );
  await signIn(page);

  const question = '¿Qué tiene abierto el sprint 42 de Plataforma? Pásame el enlace.';
  await ask(page, question);
  const card = page.getByRole('region', { name: 'Aviso de Mango: conectar Azure DevOps' });
  await expect(card).toContainText('Conecta tu cuenta de Azure DevOps');
  await expect(card).toContainText('No lo escribió el agente');
  await expect(card).toContainText(/Vence en \d+:\d{2}/);
  // The agent's link to «authorize» cannot be opened (design round 25).
  await expect(page.getByText('Autorizar Azure DevOps')).toHaveClass('rm-nolink');
  await expect(page.getByRole('button', { name: 'Autorizar Azure DevOps' })).toHaveCount(0);
  await expect(
    page.getByText('Mango desactivó un enlace del agente.', { exact: false }),
  ).toBeVisible();

  const opened = context.waitForEvent('page');
  await card.getByRole('button', { name: /Conectar/ }).click();
  const back = await opened;
  back.on('pageerror', (error) => consoleErrors.push(error.message));
  await back.waitForURL(/\/conexiones\/vuelta$/);
  await expect(
    back.getByRole('heading', { name: 'Listo, vuelve a tu pestaña de Mango' }),
  ).toBeVisible();
  await expect(back.getByText('· vuelta desde Microsoft')).toBeVisible();
  // The session id never stays in the address bar or in Web Storage (P-9).
  expect(new URL(back.url()).search).toBe('');
  for (const tab of [page, back]) {
    const stored = await tab.evaluate<string>(
      'JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])',
    );
    expect(stored).not.toMatch(/request_uri|session_id|e2e-session/);
  }
  // Opened by Mango: it closes itself after «Listo».
  await back.waitForEvent('close');
  await expect(card).toContainText('Conectado');
  await expect(card).toContainText('Tu cuenta de Azure DevOps quedó conectada.');

  // «Enviar de nuevo» sends the same question as a new turn (design round 25).
  await card.getByRole('button', { name: 'Enviar de nuevo' }).click();
  await expect(card).toContainText('Enviaste tu pregunta otra vez.');
  await expect(page.getByText(question)).toHaveCount(2);
  await expect(page.getByText('Encontré 3 work items abiertos')).toBeVisible();
  // The live turn already says what it read («Leyó») and where its links go (A1)…
  await expect(page.getByText('Leyó Azure DevOps')).toBeVisible();
  const wiki = page.getByRole('button', { name: 'wiki de Plataforma' });
  await expect(wiki).toHaveAttribute('data-host-kind', 'service');

  // …and so does the stored answer.
  await page.reload();
  await expect(page.getByText('Leyó Azure DevOps')).toBeVisible();
  // The conversation already has the question again: no second «Enviar de nuevo» (round 26).
  await expect(card).toContainText('Enviaste tu pregunta otra vez.');
  await expect(card.getByRole('button', { name: 'Enviar de nuevo' })).toHaveCount(0);
  await expect(wiki).toHaveAttribute('data-host-kind', 'service');
  await page.getByRole('button', { name: 'el tablero' }).click();
  const dialog = page.getByRole('dialog', { name: 'Abrir enlace externo' });
  await expect(dialog).toContainText('Otra organización');
  await expect(dialog).toContainText('dev.azure.com/plataforma-tableros');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();

  // Mis conexiones says it is connected, and «Desconectar» (D97, design round 24) works.
  await page.getByRole('button', { name: /^Cuenta de / }).click();
  await page.getByRole('menuitem', { name: 'Mis conexiones' }).click();
  const mine = page.getByRole('dialog', { name: 'Mis conexiones' });
  await expect(mine).toContainText('Conectado');
  await mine.getByRole('button', { name: 'Desconectar' }).click();
  const leave = page.getByRole('dialog', { name: 'Desconectar Azure DevOps' });
  await expect(leave).toContainText('Mango no cambia nada en tu cuenta de Microsoft.');
  await leave.getByRole('button', { name: 'Desconectar' }).click();
  await expect(page.getByText('Desconectaste tu cuenta de Azure DevOps')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Mis conexiones' })).toContainText(
    'No has conectado tu cuenta.',
  );
  expect(consoleErrors).toEqual([]);
});

test('a return that no tab is waiting for asks to do it again, without a session', async ({
  page,
}) => {
  await page.goto(`/conexiones/vuelta?session_id=${encodeURIComponent(SESSION)}`);
  expect(new URL(page.url()).search).toBe('');
  await expect(page.getByRole('heading', { name: 'Terminando la conexión…' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pídelo de nuevo desde Mango' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abrir Mango' })).toBeVisible();
});

test('the tab that asked waits while it keeps its token, and a reload loses it', async ({
  page,
  context,
}) => {
  // The provider's tab stays on the provider: the person has not signed in there yet.
  await context.route(AGENTCORE, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Microsoft</p>' }),
  );
  await signIn(page);
  await page.getByRole('button', { name: /^Cuenta de / }).click();
  await page.getByRole('menuitem', { name: 'Mis conexiones' }).click();
  const mine = page.getByRole('dialog', { name: 'Mis conexiones' });
  const opened = context.waitForEvent('page');
  await mine.getByRole('button', { name: 'Conectar' }).first().click();
  const provider = await opened;
  await expect(mine).toContainText('Inicia sesión en Microsoft en la otra pestaña.');
  await expect(mine.getByRole('button', { name: /Abrir de nuevo/ })).toBeVisible();
  // The provider's page has no handle on Mango's tab (reverse tabnabbing).
  expect(await provider.evaluate('window.opener === null')).toBe(true);

  // A reload drops the tab's token and its wait: the return can only say «Pídelo de nuevo».
  await page.reload();
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await provider.goto(`/conexiones/vuelta?session_id=${encodeURIComponent(SESSION)}`);
  await expect(
    provider.getByRole('heading', { name: 'Pídelo de nuevo desde Mango' }),
  ).toBeVisible();
});
