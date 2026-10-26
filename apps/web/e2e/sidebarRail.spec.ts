import { expect, test, type Page } from '@playwright/test';

// The collapsed sidebar (design round 21, 2026-10-25) against the local mock: one icon per
// group with its floating menu, keyboard and focus, the floating titles and the narrow rail.
// The app keeps its tokens in memory only, so every step navigates inside the SPA.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

test('the collapsed rail opens each group in a floating menu, by pointer and keyboard', async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Colapsar sidebar' }).click();
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  const gov = nav.getByRole('button', { name: /^Gobernanza/ });
  await expect(gov).toHaveAttribute('aria-haspopup', 'menu');
  // The group views are no longer rail links of their own.
  await expect(nav.getByRole('link', { name: 'Audit log' })).toHaveCount(0);

  // Hover opens the menu next to the rail, aligned with the icon.
  await gov.hover();
  const menu = page.getByRole('menu', { name: 'Gobernanza' });
  await expect(menu).toBeVisible();
  const [icon, box] = await Promise.all([gov.boundingBox(), menu.boundingBox()]);
  expect(box && icon && box.x).toBeGreaterThanOrEqual(60);
  expect(box && icon && Math.abs(box.y - (icon.y - 6))).toBeLessThanOrEqual(2);

  // The dot and the menu agree on what is waiting for a signature.
  const pending = /, (\d+) pendientes?$/.exec((await gov.getAttribute('aria-label')) ?? '');
  await expect(gov.locator('.sb-dot-badge')).toHaveCount(pending ? 1 : 0);
  if (pending) {
    await expect(
      menu.getByRole('menuitem', { name: `Aprobaciones (${pending[1]})` }),
    ).toBeVisible();
  }

  // Choosing a view navigates and closes the menu; the group then holds the current view.
  await menu.getByRole('menuitem', { name: /^Audit log/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  await expect(menu).toHaveCount(0);
  await expect(gov).toHaveClass(/\bis-current\b/);
  await expect(gov).toHaveAccessibleName(/^Gobernanza, contiene la vista actual/);

  // Keyboard: Enter opens on the first view, arrows move, Esc returns the focus to the icon.
  await page.mouse.move(600, 400);
  await gov.focus();
  await page.keyboard.press('Enter');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(gov).toBeFocused();

  // «Próximamente» views are listed but do not navigate.
  const build = nav.getByRole('button', { name: /^Construir/ });
  await build.click();
  const soon = page
    .getByRole('menu', { name: 'Construir' })
    .getByRole('menuitem', { name: 'Skills, próximamente' });
  await expect(soon).toHaveAttribute('aria-disabled', 'true');
  // A click outside (on the page title, not on a row that opens something) closes it.
  await page.getByRole('heading', { level: 1, name: 'Audit log' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);

  // Floating titles replace the native `title`.
  const bandeja = nav.getByRole('link', { name: /^Bandeja/ });
  await expect(bandeja).not.toHaveAttribute('title');
  await bandeja.hover();
  await expect(page.getByRole('tooltip')).toHaveText(/^Bandeja/);

  // Back to the full sidebar: the groups and their views come back.
  await page.getByRole('button', { name: 'Expandir sidebar' }).click();
  await expect(nav.getByRole('link', { name: 'Audit log' })).toBeVisible();
});

test('the narrow rail (≤ 1200 px) uses the same group menus', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 1100, height: 720 });
  await expect(page.locator('.app')).toHaveClass(/\bapp-sb-collapsed\b/);
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  await nav.getByRole('button', { name: /^Operación/ }).click();
  await page
    .getByRole('menu', { name: 'Operación' })
    .getByRole('menuitem', { name: 'Org Chart' })
    .click();
  await expect(page).toHaveURL(/\/org$/);
  await expect(nav.getByRole('button', { name: /^Operación/ })).toHaveClass(/\bis-current\b/);
});
