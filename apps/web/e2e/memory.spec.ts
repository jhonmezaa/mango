import { expect, test, type Page } from '@playwright/test';

// Memoria (D122, design round 41 memory.jsx) against the local mock: the account menu opens it,
// the records are plain text, one is deleted after confirming in its row and everything from its
// own dialog. The states the mock does not have (off in the installation, 503, 429) are answered
// with `page.route`. The app keeps its tokens in memory only, so every step navigates inside
// the SPA. The mock keeps its state between tests: the deleting test goes last.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function openMemory(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Cuenta de / }).click();
  await page.getByRole('menuitem', { name: 'Memoria' }).click();
  await expect(page).toHaveURL(/\/memory$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Memoria' })).toBeVisible();
}

async function answerMemory(
  page: Page,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<void> {
  await page.route('**/api/memory', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status,
          contentType: 'application/json',
          headers,
          body: JSON.stringify(body),
        })
      : route.fallback(),
  );
}

test('Memoria says when the installation has it off', async ({ page }) => {
  await answerMemory(page, 200, { enabled: false, records: [], complete: true, total: 0 });
  await signIn(page);
  await openMemory(page);
  await expect(
    page.getByRole('heading', { name: 'La memoria está apagada en esta instalación' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Borrar todo…' })).toHaveCount(0);
});

test('Memoria says when it is unavailable', async ({ page }) => {
  await answerMemory(page, 503, { error: { code: 'memory_unavailable', message: 'try again' } });
  await signIn(page);
  await openMemory(page);
  await expect(
    page.getByRole('heading', { name: 'La memoria no está disponible ahora' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reintentar' })).toBeEnabled();
});

test('Memoria waits out a 429 before trying again', async ({ page }) => {
  await answerMemory(
    page,
    429,
    { error: { code: 'rate_limited', message: 'too many requests' } },
    { 'Retry-After': '42' },
  );
  await signIn(page);
  await openMemory(page);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText(
    'Demasiadas solicitudes. Puedes pedir tu memoria hasta 30 veces por minuto.',
  );
  await expect(alert.getByRole('button', { name: /Reintentar en/ })).toBeDisabled();
});

test('Memoria lists the records as text, filters them and deletes them', async ({ page }) => {
  await signIn(page);
  await openMemory(page);

  await expect(page.getByText('6 recuerdos')).toBeVisible();
  // A record with HTML is text.
  await expect(
    page.getByText('Pidió las tablas en <b>negrita</b>: se guardó como texto.'),
  ).toBeVisible();
  await expect(page.locator('.mm-text b')).toHaveCount(0);
  await expect(page.getByText('Texto recortado: el recuerdo completo es más largo.')).toBeVisible();

  await page.getByRole('button', { name: 'Hechos', exact: true }).click();
  await expect(page.getByText('2 de 6')).toBeVisible();
  await page.getByRole('combobox', { name: 'Agente' }).selectOption({ label: 'FinOps' });
  await expect(page.getByText('1 de 6')).toBeVisible();
  await page.getByRole('button', { name: 'Todos', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agente' }).selectOption({ label: 'Todos los agentes' });

  // One record, confirmed in its row (no browser dialog).
  await page.getByRole('button', { name: 'Borrar este recuerdo' }).first().click();
  const confirm = page.getByRole('group', { name: 'Confirmar borrado' });
  await expect(confirm).toContainText('FinOps dejará de recordarlo. No se puede deshacer.');
  await confirm.getByRole('button', { name: 'Borrar', exact: true }).click();
  await expect(page.getByText('Recuerdo borrado.')).toBeVisible();
  await expect(page.getByText('5 recuerdos')).toBeVisible();

  // Everything, from its own dialog.
  await page.getByRole('button', { name: 'Borrar todo…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Borrar toda tu memoria' });
  await expect(dialog).toContainText(
    'Todos los agentes dejarán de recordar lo que saben de ti: 5 recuerdos, y lo que guardaron tus tareas. No se puede deshacer.',
  );
  await dialog.getByRole('button', { name: 'Borrar todo', exact: true }).click();
  await expect(page.getByText('Se borraron 5 recuerdos y 33 eventos.')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Ningún agente recuerda nada de ti' }),
  ).toBeVisible();
});
