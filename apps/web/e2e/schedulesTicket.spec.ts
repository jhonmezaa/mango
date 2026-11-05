import { expect, test, type Page } from '@playwright/test';

// «Crear ticket» as an output of a Schedules task (D112), against the local mock. The mock keeps
// its state between tests, so the task this spec creates has its own name.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

test('a task with «Crear ticket» keeps it after saving', async ({ page }) => {
  await signIn(page);
  // Construir starts closed in the sidebar (design default: only Gobernanza open).
  await page.getByRole('button', { name: 'Construir' }).click();
  await page.getByRole('link', { name: 'Schedules', exact: true }).first().click();
  await page.getByRole('button', { name: 'Nuevo schedule' }).click();
  const editor = page.getByRole('dialog');
  await expect(editor.getByText(/te llega a la Bandeja\. Solo tú lo ves\./)).toBeVisible();
  await editor.getByRole('button', { name: 'Crear ticket' }).click();
  await expect(editor.getByRole('button', { name: 'Crear ticket' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(editor.getByText(/Cada ejecución que termina bien deja su resultado/)).toBeVisible();
  await expect(editor.getByText(/Solo tú lo ves/)).toHaveCount(0);
  await editor.getByLabel('Nombre').fill('Ticket e2e');
  await editor.getByLabel('Tarea').fill('Revisa el gasto de la semana');
  await editor.getByRole('button', { name: 'Crear schedule' }).click();
  // Saving opens the detail of the new task.
  const detail = page.getByRole('dialog', { name: 'Ticket e2e' });
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: /Editar/ }).click();
  await expect(page.getByRole('button', { name: 'Crear ticket' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
