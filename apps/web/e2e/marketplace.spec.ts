import { expect, test, type Page } from '@playwright/test';

// Marketplace v1, phase A: create an agent, review it and use it, against the local mock.
// The app keeps its tokens in memory only, so every step navigates inside the SPA: a page
// reload would sign the user out (and that is asserted at the end).

const NEW_AGENT = 'Analista LATAM';
/** Agent of another administrator that waits for review in the mock (`mock/agents.ts`). */
const OTHERS_AGENT = 'Anomalías <b>Retail</b>';
/** Approved by the mock user, but its publication failed: shared with one of their groups. */
const RETRIED_AGENT = 'Etiquetado';

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function open(page: Page, section: string): Promise<void> {
  await page.getByRole('link', { name: section, exact: true }).first().click();
}

test.describe.configure({ mode: 'serial' });

test.describe('Marketplace: create, review and use an agent', () => {
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

  test('a creator builds an agent and sends it to review', async () => {
    await open(page, 'Marketplace');
    await page.getByRole('link', { name: 'Nuevo agente' }).click();
    await expect(page).toHaveURL(/\/admin$/);

    await page.getByLabel('Nombre').fill(NEW_AGENT);
    await page.getByLabel('Reporta a').selectOption('finops');
    await page.getByLabel('Rol', { exact: true }).fill('Analista regional');
    await page.getByLabel('System prompt').fill('Analiza el gasto de LATAM y responde en español.');
    await page.getByRole('button', { name: /^get_cost_and_usage/ }).click();
    await page.getByRole('button', { name: /^finops-central/ }).click();

    // There is no way to publish from the Builder: only to send for approval.
    await expect(page.getByRole('button', { name: /^Publicar/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Enviar a aprobación' }).click();

    await expect(page).toHaveURL(/\/marketplace$/);
    await expect(
      page.getByText('Enviado a aprobación · lo revisará otro administrador'),
    ).toBeVisible();
    // Not published yet: it is listed as work in progress, never as an agent to use.
    const inProgress = page.getByRole('link', { name: new RegExp(NEW_AGENT) });
    await expect(inProgress).toBeVisible();
    await expect(inProgress).toHaveAttribute('href', /^\/admin\/[a-z2-7]{16}\/1$/);
    await expect(page.locator('.mk-card', { hasText: NEW_AGENT })).toHaveCount(0);
  });

  test('whoever wrote a version cannot approve it', async () => {
    await open(page, 'Revisión de agentes');
    const queue = page.getByRole('listbox', { name: 'Agentes en revisión' });
    const own = queue.getByRole('option', { name: new RegExp(NEW_AGENT) });
    await expect(own).toContainText('Tuyo');
    await own.click();
    const detail = page.locator('.ap-detail');
    await expect(detail.getByRole('heading', { name: NEW_AGENT })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Aprobar y publicar' })).toBeDisabled();
    await expect(detail.getByRole('button', { name: 'Rechazar' })).toBeDisabled();
    await expect(detail).toContainText('Lo hiciste tú: lo debe aprobar otro administrador.');
  });

  test('another administrator reviews the diff, approves, and the agent is published', async () => {
    const queue = page.getByRole('listbox', { name: 'Agentes en revisión' });
    await queue.getByRole('option', { name: /Anomalías/ }).click();
    const detail = page.locator('.ap-detail');
    // Creator text is shown as text: the markup of the name is never rendered.
    await expect(detail.getByRole('heading', { name: OTHERS_AGENT })).toBeVisible();
    await expect(detail.locator('script, img')).toHaveCount(0);
    await expect(detail).toContainText('cost-explorer.get_anomalies');

    await detail.getByRole('button', { name: 'Aprobar y publicar' }).click();
    await expect(page.getByText(`Aprobado · publicando ${OTHERS_AGENT}`)).toBeVisible();
    await expect(queue.getByRole('option', { name: /Anomalías/ })).toContainText('Publicando…');

    // The provisioner of the mock publishes it; the queue lets go of it by itself.
    await expect(queue.getByRole('option', { name: /Anomalías/ })).toHaveCount(0, {
      timeout: 20_000,
    });
    await page.getByRole('tab', { name: 'Historial' }).click();
    const row = page
      .getByRole('table', { name: 'Historial de revisiones' })
      .getByRole('row', { name: /Anomalías/ });
    await expect(row).toContainText('Publicado');
  });

  test('a failed publication is retried from the history and gets published', async () => {
    const history = page.getByRole('table', { name: 'Historial de revisiones' });
    const failed = history.getByRole('row', { name: new RegExp(RETRIED_AGENT) });
    await expect(failed).toContainText('Fallido');
    await expect(failed).toContainText('Falló en «create_harness»');
    await failed.getByRole('button', { name: `Reintentar: ${RETRIED_AGENT}` }).click();
    await expect(page.getByText('Reintentando publicación')).toBeVisible();
    await expect(history.getByRole('row', { name: new RegExp(RETRIED_AGENT) })).toContainText(
      'Publicado',
      { timeout: 20_000 },
    );
  });

  test('the Marketplace lists only what the user may use, and the agent answers in the chat', async () => {
    await open(page, 'Marketplace');
    const usable = page.locator('.mk-card', { hasText: RETRIED_AGENT });
    await expect(usable).toBeVisible();
    // Published too, but shared with a group the user is not in: approving is not using.
    await expect(page.locator('.mk-card', { hasText: 'Anomalías' })).toHaveCount(0);
    // Still waiting for another administrator.
    await expect(page.locator('.mk-card', { hasText: NEW_AGENT })).toHaveCount(0);

    await usable.getByRole('button', { name: 'Abrir chat' }).click();
    await expect(page).toHaveURL(/\/\?agent=p2ys6ke4c7dq3hzo$/);
    await expect(page.getByRole('heading', { name: RETRIED_AGENT })).toBeVisible();
    await page.getByRole('textbox', { name: /Mensaje/ }).fill('¿Qué recursos no tienen etiquetas?');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect(page.getByText('¿Qué recursos no tienen etiquetas?')).toBeVisible();
    // The answer streams in and ends: the agent's message is no longer busy.
    const answer = page.locator('article.msg-agent').last();
    await expect(answer).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });
    await expect(answer).not.toBeEmpty();
  });

  test('retiring an agent shows admins the removal of its infrastructure until it ends', async () => {
    test.setTimeout(90_000);
    await open(page, 'Marketplace');
    await page.getByRole('button', { name: `Más opciones de ${RETRIED_AGENT}` }).click();
    await page.getByRole('menuitem', { name: 'Retirar…' }).click();
    const dialog = page.getByRole('dialog', { name: `Retirar “${RETRIED_AGENT}”` });
    await expect(dialog).toContainText('Su infraestructura se borra en segundo plano');
    await dialog.getByLabel('Motivo').fill('Prueba de extremo a extremo');
    await dialog.getByRole('button', { name: 'Retirar', exact: true }).click();
    await expect(page.getByText(`"${RETRIED_AGENT}" retirado`)).toBeVisible();

    await page.getByRole('tab', { name: /Retirados/ }).click();
    const retired = page.locator('.mk-card', { hasText: RETRIED_AGENT });
    await expect(retired).toContainText('Limpiando');
    await retired.click();
    const detail = page.getByRole('dialog', { name: RETRIED_AGENT });
    await expect(detail).toContainText('Retirado · Prueba de extremo a extremo');
    await expect(detail.getByRole('status')).toContainText('Borrando su infraestructura');
    await detail.getByRole('button', { name: 'Cerrar' }).click();
    // No reload: the page reads the agents again until the removal ends.
    await expect(retired).not.toContainText('Limpiando', { timeout: 60_000 });
    await expect(retired).toContainText('Retirado');
  });

  test('nothing was logged as an error, and a reload keeps the session', async () => {
    expect(consoleErrors).toEqual([]);
    // The session cookie of the server (D63); `sessionReload.spec.ts` covers signing out.
    await page.reload();
    await expect(page.getByRole('navigation').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
  });
});
