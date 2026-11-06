import { expect, test, type Page } from '@playwright/test';

// Evals (D110, D111) against the local mock (`mock/evals.ts`). The app keeps its tokens in
// memory only, so every step navigates inside the SPA. The mock keeps its state across tests:
// they run in order and each one reads what the one before left.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

function row(page: Page, name: string) {
  return page.locator('.ev-tr[role="button"]', { hasText: name });
}

test.describe.configure({ mode: 'serial' });

test.describe('Evals: list, detail, a run and a new suite', () => {
  let page: Page;
  const consoleErrors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await signIn(page);
    const link = page.getByRole('link', { name: 'Evals', exact: true }).first();
    if (!(await link.isVisible())) await page.getByRole('button', { name: 'Operación' }).click();
    await link.click();
    await expect(page).toHaveURL(/\/evals$/);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('lists the suites with their score, trend and how the last run ended', async () => {
    await expect(page.getByRole('heading', { level: 1, name: 'Evals' })).toBeVisible();
    await expect(row(page, 'Preguntas frecuentes de gasto')).toContainText('100%');
    await expect(row(page, 'Preguntas frecuentes de gasto')).toContainText('Obligatoria');
    await expect(row(page, 'Casos que ya fallaron')).toContainText('34%');
    await expect(row(page, 'Resumen semanal')).toContainText('No empezó por presupuesto');
    await expect(page.getByText('Agentes sin evals')).toBeVisible();
    await page.getByRole('button', { name: /^No pasan/ }).click();
    await expect(page.locator('.ev-tr[role="button"]')).toHaveCount(1);
    await page.getByRole('button', { name: /^Todas/ }).click();
  });

  test('the detail shows verdicts and reasons, never an answer, and the cost', async () => {
    await row(page, 'Casos que ya fallaron').click();
    const panel = page.getByRole('dialog', { name: 'Casos que ya fallaron' });
    await expect(panel.getByText('No cumple: falta «rango»')).toBeVisible();
    await expect(panel.getByText(/la respuesta del agente no/)).toBeVisible();
    await expect(panel.getByText(/hasta USD 0,64/)).toBeVisible();
    await panel.getByRole('button', { name: 'Cerrar' }).click();

    await row(page, 'Resumen semanal').click();
    const stopped = page.getByRole('dialog', { name: 'Resumen semanal' });
    await expect(stopped.getByRole('alert')).toContainText('No empezó: no alcanza tu presupuesto');
    await stopped.getByRole('button', { name: 'Cerrar' }).click();
  });

  test('a run goes case by case and ends with a toast', async () => {
    await page.getByRole('button', { name: 'Ejecutar Casos que ya fallaron', exact: true }).click();
    await expect(row(page, 'Casos que ya fallaron')).toContainText(/Caso \d de 3/);
    await expect(
      page.getByText('Casos que ya fallaron: 33% · no pasa el umbral de 75%'),
    ).toBeVisible({
      timeout: 15_000,
    });
  });

  test('a new suite from a CSV, with the server estimate', async () => {
    await page.getByRole('button', { name: 'Nueva suite' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Nueva suite de evals' });
    await dialog.getByLabel('Nombre de la suite').fill('Golden e2e');
    await dialog.getByRole('button', { name: 'Siguiente' }).click();
    await expect(dialog.getByRole('button', { name: /Generar con IA/ })).toBeDisabled();
    await dialog
      .getByLabel('Casos en CSV')
      .fill(
        'pregunta,respuesta esperada,criterio\n"¿Gasto de EC2?","","contiene: EC2"\n"Resume","Un resumen",',
      );
    await dialog.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(dialog.getByText('2 casos importados')).toBeVisible();
    await dialog.getByRole('button', { name: 'Siguiente' }).click();
    await expect(dialog.getByLabel('Modelo juez')).toBeVisible();
    await dialog.getByRole('button', { name: 'Siguiente' }).click();
    await expect(dialog.getByText(/hasta USD 0,45/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Crear suite' }).click();
    await expect(page.getByRole('dialog', { name: 'Golden e2e' })).toBeVisible();
    await page
      .getByRole('dialog', { name: 'Golden e2e' })
      .getByRole('button', { name: 'Cerrar' })
      .click();
    await expect(row(page, 'Golden e2e')).toContainText('Sin ejecutar');
    expect(consoleErrors).toEqual([]);
  });

  test('a request to stop requiring a suite shows its reason; rejecting asks for one', async () => {
    await row(page, 'Prompt injection y fugas').click();
    const panel = page.getByRole('dialog', { name: 'Prompt injection y fugas' });
    await expect(panel.getByText('Motivo: Se reemplaza por otra suite')).toBeVisible();
    await panel.getByRole('button', { name: 'Rechazar', exact: true }).click();
    const send = panel.getByRole('button', { name: 'Rechazar pedido' });
    await expect(send).toBeDisabled();
    await panel.getByLabel('Por qué rechazas el pedido').fill('Es la única de seguridad');
    await send.click();
    await expect(page.getByText('Pedido rechazado · sigue siendo obligatoria')).toBeVisible();
    await expect(panel.getByText(/^Motivo:/)).toHaveCount(0);

    // Turning «Obligatoria» off is a request with its reason, sent from the same drawer.
    // The toggle is enabled again once the suite is read without the request.
    const required = panel.getByRole('checkbox', { name: /Obligatoria para aprobar/ });
    await expect(required).toBeEnabled();
    await panel.getByText('Obligatoria para aprobar', { exact: true }).click();
    await panel.getByLabel('Por qué deja de ser obligatoria').fill('La reemplaza otra suite');
    await panel.getByRole('button', { name: 'Enviar pedido' }).click();
    await expect(page.getByText('Pedido enviado · otro admin debe aprobarlo')).toBeVisible();
    await expect(panel.getByText('Motivo: La reemplaza otra suite')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Cancelar pedido' })).toBeVisible();
    await panel.getByRole('button', { name: 'Cancelar pedido' }).click();
    await panel.getByRole('button', { name: 'Cerrar' }).click();
    expect(consoleErrors).toEqual([]);
  });
});
