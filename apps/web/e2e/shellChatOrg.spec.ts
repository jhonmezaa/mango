import { expect, test, type Page } from '@playwright/test';

// Design round «Alineación con el producto» (oct 2026): account menu, chat states and Org Chart,
// against the local mock. The app keeps its tokens in memory only, so every step navigates
// inside the SPA.

/** Retired agent of the mock (`mock/agents.ts`). */
const RETIRED_AGENT_ID = 'h5cu4n6sl2we7ygt';

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

/** In-app navigation to a URL nothing links to (a reload would sign the user out). */
async function pushRoute(page: Page, path: string): Promise<void> {
  // Evaluated as a string: this project is not compiled with the DOM types.
  await page.evaluate(
    `window.history.pushState({}, '', ${JSON.stringify(path)});
     window.dispatchEvent(new PopStateEvent('popstate'));`,
  );
}

test.describe.configure({ mode: 'serial' });

test.describe('Shell, chat and Org Chart', () => {
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

  test('the account menu shows the role label and the groups', async () => {
    const account = page.getByRole('button', { name: /Cuenta de Usuario 1/ });
    await expect(account.locator('.sb-user-role')).toHaveText('Admin');
    await account.click();
    const menu = page.getByRole('menu');
    await expect(menu.locator('.sb-menu-role')).toHaveText('Admin');
    await expect(menu.locator('.sb-menu-groups .badge')).toHaveText([
      'finops-central',
      'mango-admin',
    ]);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('an agent without suggestions shows none, and no status dot', async () => {
    await page.getByRole('link', { name: 'Marketplace', exact: true }).first().click();
    await expect(page).toHaveURL(/\/marketplace$/);
    await page.locator('header').getByRole('button', { name: 'Nueva conversación' }).click();
    const picker = page.getByRole('dialog', { name: 'Nueva conversación' });
    // The mock user may create agents.
    await expect(picker.getByRole('button', { name: 'Crear nuevo agente' })).toBeVisible();
    await expect(picker.getByRole('button', { name: 'Ver Marketplace' })).toHaveCount(0);
    await picker.locator('.picker-card', { hasText: 'Savings Plans' }).first().click();

    const hero = page.locator('.agent-hero');
    await expect(hero.getByRole('heading', { level: 1, name: 'Savings Plans' })).toBeVisible();
    await expect(hero).not.toContainText('En línea');
    await expect(hero.locator('.dot')).toHaveCount(0);
    // Nor does the header of the chat (design closing round, 2026-10-02).
    const header = page.locator('header.topbar');
    await expect(header).not.toContainText('En línea');
    await expect(header.locator('.dot')).toHaveCount(0);
    await expect(hero.getByRole('heading', { name: 'Sugerencias' })).toHaveCount(0);
    await expect(hero.locator('.suggestion')).toHaveCount(0);

    // The release agent keeps its line, capabilities and questions.
    await page.getByRole('link', { name: 'Chat con FinOps' }).click();
    await expect(hero).toContainText('Agente de costos de AWS');
    await expect(hero.getByRole('heading', { name: 'Sugerencias' })).toBeVisible();
    await expect(hero.locator('.suggestion')).toHaveCount(4);
  });

  test('a retired agent blocks the conversation and points to the Marketplace', async () => {
    await pushRoute(page, `/?agent=${RETIRED_AGENT_ID}`);
    const blocked = page.locator('.chat-blocked');
    await expect(blocked.getByRole('heading', { name: 'Este agente fue retirado' })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    const box = page.locator('.composer-blocked-box');
    await expect(box).toContainText('No se pueden enviar mensajes a un agente retirado.');
    await box.getByRole('link', { name: 'Ir al Marketplace' }).click();
    await expect(page).toHaveURL(/\/marketplace$/);
  });

  test('the Org Chart marks the root and what is not available yet', async () => {
    const link = page.getByRole('link', { name: 'Org Chart', exact: true }).first();
    // The "Operación" group of the sidebar may be collapsed.
    if (!(await link.isVisible())) await page.getByRole('button', { name: 'Operación' }).click();
    await link.click();
    await expect(page).toHaveURL(/\/org$/);

    const root = page.getByRole('button', {
      name: 'Platform Admin, Raíz · no es un agente',
    });
    await expect(root).toBeVisible();
    await expect(page.locator('.oc-pip')).toHaveCount(0);
    await expect(page.locator('.oc-stats > div', { hasText: 'Con alertas' })).toContainText(
      'Próximamente',
    );
    const delegation = page.locator('.oc-deleg-soon');
    await expect(delegation).toContainText('Delegación A2A');
    await expect(delegation).toContainText('Próximamente');
    await expect(page.locator('.oc-deleg')).toHaveCount(0);
    // Admins and creators get the whole tree.
    await expect(page.locator('.page-subtitle')).not.toContainText('Ves solo los agentes');

    await root.click();
    const panel = page.getByRole('complementary', { name: 'Detalle de Platform Admin' });
    await expect(panel).toContainText('Platform Admin es la raíz del organigrama, no un agente.');
  });

  test('at 760px and below the panel goes under the chart and the toolbar wraps', async () => {
    await page.setViewportSize({ width: 420, height: 900 });
    const chart = page.getByRole('region', { name: 'Organigrama' });
    const panel = page.getByRole('complementary', { name: 'Detalle de Platform Admin' });
    await expect(panel).toBeVisible();
    const chartBox = await chart.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(chartBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    if (!chartBox || !panelBox) return;
    expect(panelBox.y).toBeGreaterThanOrEqual(chartBox.y + chartBox.height);
    expect(Math.round(panelBox.width)).toBe(Math.round(chartBox.width));
    // Nothing overflows the viewport: the toolbar wraps.
    const overflow = await page.evaluate<number>(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const tools = await page.locator('.oc-tools').boundingBox();
    expect(tools && tools.x + tools.width).toBeLessThanOrEqual(420);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('at 560px and below the toasts go under the top bar, clear of the composer', async () => {
    await page.setViewportSize({ width: 420, height: 900 });
    await pushRoute(page, '/');
    await page.locator('#chat-input').fill('hola');
    await page.locator('#chat-input').press('Enter');
    const toast = page.locator('.g-toast-item', { hasText: 'Respuesta completa' });
    await expect(toast).toBeVisible({ timeout: 30_000 });
    const toastBox = await toast.boundingBox();
    const composerBox = await page.locator('.composer-box').boundingBox();
    expect(toastBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    if (!toastBox || !composerBox) return;
    expect(toastBox.y + toastBox.height).toBeLessThan(composerBox.y);
    expect(Math.round(toastBox.x)).toBe(12);
    expect(Math.round(toastBox.x + toastBox.width)).toBe(408);
    // While the toast is up, the point at the centre of the send button is the button.
    const reachesSend = await page.evaluate<boolean>(
      `(() => {
        const send = document.querySelector('.ch-send-btn');
        const box = send.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return document.querySelector('.g-toast-item') !== null && send.contains(hit);
      })()`,
    );
    expect(reachesSend).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('leaves no errors in the console', () => {
    expect(consoleErrors).toEqual([]);
  });
});
