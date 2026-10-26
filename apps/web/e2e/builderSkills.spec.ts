import { expect, test, type Page } from '@playwright/test';

// Agent Builder › Skills (Claude Design round 21, D92) against the local mock (`mock/skills.ts`).
// The app keeps its tokens in memory only, so every step navigates inside the SPA.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

test('a skill is pinned to its latest approved version and says what it needs', async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Marketplace', exact: true }).first().click();
  await page.getByRole('link', { name: 'Nuevo agente', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Nuevo agente' })).toBeVisible();

  const section = page.locator('#ab-skills');
  await expect(section.getByRole('heading', { name: 'Skills' })).toBeVisible();
  await expect(
    section.getByText(
      'Sin skills. El agente responde solo con su prompt, sus tools y sus knowledge bases.',
    ),
  ).toBeVisible();
  // A skill over a server that is not in the catalog cannot be chosen.
  await expect(
    section.getByRole('option', { name: 'Conciliación de facturas · v1 · MCP no habilitado' }),
  ).toBeDisabled();

  const add = section.getByRole('combobox', { name: 'Agregar skill' });
  const option = section.getByRole('option', { name: /^Precios de instancias · v\d+$/ });
  const value = await option.getAttribute('value');
  await add.selectOption(value ?? '');
  await expect(section.getByText(/^precios-de-instancias@v\d+$/)).toBeVisible();
  await expect(section.getByText('1 de 10')).toBeVisible();
  // The new agent has no tool of AWS Pricing yet.
  await expect(
    section.getByText(/La skill Precios de instancias requiere AWS Pricing/),
  ).toBeVisible();

  await section.getByRole('button', { name: 'Quitar Precios de instancias' }).click();
  await expect(section.getByText('0 de 10')).toBeVisible();
  await expect(section.getByRole('link', { name: 'Ver catálogo de skills' })).toHaveAttribute(
    'href',
    '/skills',
  );
});
