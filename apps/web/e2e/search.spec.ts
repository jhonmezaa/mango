import { expect, test, type Page } from '@playwright/test';

// Buscar conversaciones (D103, design search.jsx) against the local mock: the sidebar entry, the
// `/` shortcut, a search with its snippets and marks, the filters, the keyboard, the line of a
// search that stopped at its cap, and opening a result in the chat. The app keeps its tokens in
// memory only, so every step navigates inside the SPA.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function openSearch(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  await nav.getByRole('link', { name: 'Buscar conversaciones', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Buscar conversaciones', level: 1 }),
  ).toBeVisible();
}

const searchBox = (page: Page) => page.getByRole('combobox', { name: 'Buscar en conversaciones' });

test('Buscar conversaciones finds the terms and opens the conversation with Enter', async ({
  page,
}) => {
  await signIn(page);
  await openSearch(page);
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.getByText('conversaciones recientes')).toBeVisible();

  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('/');
  await expect(searchBox(page)).toBeFocused();

  const answer = page.waitForResponse((r) => r.url().endsWith('/search/conversations'));
  await searchBox(page).fill('ec2 mes');
  expect((await answer).status()).toBe(200);
  const results = page.getByRole('listbox', { name: 'Buscar conversaciones' });
  const first = results.getByRole('option').first();
  await expect(first).toContainText('Gasto de EC2 del mes');
  await expect(first.locator('mark.sr-mark').first()).toHaveText(/ec2|mes/i);
  await expect(page.getByText(/coincidencias? en/)).toBeVisible();
  // Stored HTML of a title is text, never markup.
  await expect(page.locator('.sr-wrap b:has-text("de la semana")')).toHaveCount(0);

  await page.getByRole('button', { name: 'Herramientas' }).click();
  await searchBox(page).fill('get_cost_forecast');
  await expect(results.getByText('Herramienta').first()).toBeVisible();
  await page.getByRole('button', { name: 'Limpiar' }).click();
  await expect(page.getByRole('button', { name: 'Todo' })).toHaveAttribute('aria-pressed', 'true');

  await searchBox(page).fill('ec2 mes');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await searchBox(page).press('Enter');
  await expect(page).toHaveURL(/\/c\/[A-Za-z0-9_-]+$/);
  await expect(page.getByText('Gasto de EC2 del mes').first()).toBeVisible();
});

test('Buscar conversaciones says when a search did not cover everything', async ({ page }) => {
  await signIn(page);
  await openSearch(page);
  // The mock answers `capped` when the query holds «mock-capped».
  await searchBox(page).fill('mock-capped');
  await expect(page.getByText('Sin resultados para “mock-capped”')).toBeVisible();
  await expect(
    page.getByText(/conversaciones? más recientes?; las más antiguas no se revisaron/),
  ).toBeVisible();
  // Enter without results remembers the search (design).
  await searchBox(page).press('Enter');
  await searchBox(page).press('Escape');
  await expect(searchBox(page)).toHaveValue('');
  // Remembered while the tab is open, in memory only.
  await expect(page.getByText('búsquedas recientes')).toBeVisible();
  const stored = await page.evaluate<string>(
    'JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])',
  );
  expect(stored).not.toContain('mock-capped');
});
