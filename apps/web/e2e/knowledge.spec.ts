import { expect, test, type Page } from '@playwright/test';

// Knowledge Bases (D88) against the local mock (`mock/knowledge.ts`). The app keeps its tokens in
// memory only, so every step navigates inside the SPA.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

function row(page: Page, name: string) {
  return page.locator('button.kb-tr', { hasText: name });
}

test.describe.configure({ mode: 'serial' });

test.describe('Knowledge Bases: list, panel, create and synchronize', () => {
  let page: Page;
  const consoleErrors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await signIn(page);
    const link = page.getByRole('link', { name: 'Knowledge Bases', exact: true }).first();
    // The "Construir" group of the sidebar may be collapsed.
    if (!(await link.isVisible())) await page.getByRole('button', { name: 'Construir' }).click();
    await link.click();
    await expect(page).toHaveURL(/\/knowledge$/);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('lists every state of the screen, names as text', async () => {
    await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Bases' })).toBeVisible();
    await expect(row(page, 'Políticas de RH')).toContainText('Indexada');
    await expect(row(page, 'Políticas de RH')).toContainText('Acceso parcial');
    await expect(row(page, 'Security Baseline')).toContainText('Pendiente de aprobación');
    await expect(row(page, 'Etiquetado de costos')).toContainText('por presupuesto');
    await expect(row(page, 'Release Archive')).toContainText('supera el tope');
    await expect(row(page, 'Customer Docs')).toContainText('Bucket rechazado');
    await expect(row(page, '<b>Manual</b>')).toContainText('Sin documentos');
    await expect(page.locator('main img')).toHaveCount(0);
  });

  test('the panel says why a bucket was rejected, with its note', async () => {
    await row(page, 'Customer Docs').click();
    const panel = page.getByRole('dialog', { name: 'Customer Docs' });
    await expect(panel).toContainText(
      'otra.admin@example.com rechazó leer s3://empresa-sitio/docs/: «Es la documentación del sitio público',
    );
    await panel.getByRole('button', { name: 'Proponer otro bucket' }).click();
    await expect(panel.getByRole('tab', { name: 'Acceso y sync' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await panel.getByRole('button', { name: 'Proponer otro bucket' }).click();
    await panel.getByLabel('Bucket y prefijo').fill('s3://mango-poc-documents/kb/');
    await panel.getByRole('button', { name: 'Enviar a aprobación' }).click();
    await expect(panel.getByRole('alert')).toHaveText(
      'Ese bucket es de Mango y no se puede usar como fuente.',
    );
    await panel.getByLabel('Bucket y prefijo').fill('s3://empresa-sitio/interno/');
    await panel.getByRole('button', { name: 'Enviar a aprobación' }).click();
    await expect(page.getByText('Propuesta enviada · la aprueba otro administrador')).toBeVisible();
    await expect(panel).toContainText('Espera a que lo apruebe un administrador distinto');
    await panel.getByRole('button', { name: 'Retirar propuesta' }).click();
    await expect(page.getByText('Propuesta retirada')).toBeVisible();
    await panel.getByRole('button', { name: 'Cerrar' }).click();
    await expect(row(page, 'Customer Docs')).toContainText('Sin bucket');
  });

  test('«Sincronizar ahora» runs, and a second one says there is one running', async () => {
    await row(page, 'Etiquetado de costos').click();
    const panel = page.getByRole('dialog', { name: 'Etiquetado de costos' });
    await expect(panel).toContainText('los embeddings costarían unos USD 12,40');
    await panel.getByRole('button', { name: 'Sincronizar ahora' }).click();
    await expect(page.getByText('Sincronizando Etiquetado de costos')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Sincronizando…' })).toBeDisabled();
    // No reload: the page reads the list again until the synchronization ends.
    await expect(panel.getByRole('button', { name: 'Sincronizar ahora' })).toBeEnabled({
      timeout: 20_000,
    });
    await panel.getByRole('button', { name: 'Cerrar' }).click();
    await expect(row(page, 'Etiquetado de costos')).toContainText('Sincronizada');
  });

  test('creating a knowledge base of files opens it', async () => {
    await page.getByRole('button', { name: 'Nueva knowledge base' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nueva knowledge base' });
    await dialog.getByLabel('Nombre').fill('Manuales de compra');
    await dialog.getByRole('button', { name: 'finops-central' }).click();
    await dialog.getByRole('button', { name: 'Crear y subir archivos' }).click();
    await expect(page.getByText('Creada · sube sus archivos')).toBeVisible();
    const panel = page.getByRole('dialog', { name: 'Manuales de compra' });
    await expect(panel).toContainText('Todavía no tiene documentos.');
    await panel.getByRole('button', { name: 'Cerrar' }).click();
    await expect(row(page, 'Manuales de compra')).toContainText('Sin documentos');
  });

  test('a knowledge base agents use cannot be deleted; another one can', async () => {
    await row(page, 'Políticas de RH').click();
    let panel = page.getByRole('dialog', { name: 'Políticas de RH' });
    await panel.getByRole('tab', { name: 'Acceso' }).click();
    await expect(panel).toContainText('No se puede borrar: la usa People Docs, ya publicado.');
    await expect(panel.getByRole('button', { name: 'Borrar knowledge base' })).toBeDisabled();
    await panel.getByRole('button', { name: 'Cerrar' }).click();

    await row(page, 'Manuales de compra').click();
    panel = page.getByRole('dialog', { name: 'Manuales de compra' });
    await panel.getByRole('tab', { name: 'Acceso' }).click();
    await panel.getByRole('button', { name: 'Borrar knowledge base' }).click();
    await panel.getByRole('button', { name: 'Borrar', exact: true }).click();
    await expect(page.getByText('Borrando Manuales de compra')).toBeVisible();
    await panel.getByRole('button', { name: 'Cerrar' }).click();
    await expect(row(page, 'Manuales de compra')).toHaveCount(0, { timeout: 20_000 });
  });

  test('no errors in the console but the refused bucket', () => {
    // The browser logs the 422 of the Mango bucket the API refused (second test); nothing else.
    expect(consoleErrors).toEqual([
      'Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)',
    ]);
  });
});
