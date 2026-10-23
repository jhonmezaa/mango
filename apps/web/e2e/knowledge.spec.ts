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
    await expect(row(page, 'Políticas de RH')).toContainText('Con avisos');
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

  test('a new knowledge base of files opens on its upload; saved files get indexed', async () => {
    await page.getByRole('button', { name: 'Nueva knowledge base' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nueva knowledge base' });
    await dialog.getByLabel('Nombre').fill('Manuales de compra');
    await dialog.getByRole('button', { name: 'finops-central' }).click();
    await dialog.getByRole('button', { name: 'Crear y subir archivos' }).click();
    await expect(page.getByText('Creada · sube sus archivos')).toBeVisible();
    const panel = page.getByRole('dialog', { name: 'Manuales de compra' });
    await expect(panel.locator('.sc-res-h')).toHaveText('Subir archivos');
    await panel.getByTestId('kb-file-input').setInputFiles([
      { name: 'Gastos.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 gastos') },
      {
        name: 'Formulario-escaneado.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7'),
      },
      { name: 'Organigrama.png', mimeType: 'image/png', buffer: Buffer.from('png') },
    ]);
    await expect(panel.getByText('Rechazado · Tipo no admitido')).toBeVisible();
    await expect(panel.getByText(/^Subido/)).toHaveCount(2);
    // Leaving with files uploaded and not saved asks first.
    await panel.getByRole('tab', { name: 'Resumen' }).click();
    await expect(
      panel.getByText('Tienes 2 archivos subidos sin guardar.', { exact: false }),
    ).toBeVisible();
    await panel.getByRole('button', { name: 'Seguir aquí' }).click();
    await panel.getByRole('button', { name: 'Guardar 2 archivos' }).click();
    await expect(page.getByText('2 archivos guardados · indexando')).toBeVisible();
    await expect(panel.getByText('En curso · 2')).toBeVisible();
    // The scanned one has no text to index.
    await expect(panel.getByText('No indexados · 1')).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText('OCR sin texto legible')).toBeVisible();
    await expect(panel.getByText('Indexados · 1', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Cerrar' }).click();
    await expect(row(page, 'Manuales de compra')).toContainText('Con avisos');
  });

  test('«Probar búsqueda» shows the fragments as text', async () => {
    await row(page, 'Políticas de RH').click();
    const panel = page.getByRole('dialog', { name: 'Políticas de RH' });
    await expect(panel).toContainText('1 documento no se pudo indexar: los agentes no lo ven.');
    await panel.getByRole('tab', { name: 'Probar búsqueda' }).click();
    await panel.getByLabel('Consulta de prueba').fill('vacaciones');
    await panel.getByRole('button', { name: 'Buscar' }).click();
    await expect(panel.locator('.kb-hit')).toHaveCount(3);
    await expect(panel.locator('.kb-hit').first()).toContainText('<b>Texto</b> del documento');
    await expect(panel.locator('.kb-hit b')).toHaveCount(0);
    await expect(panel.getByText('0,58')).toBeVisible();
    await panel.getByRole('button', { name: 'Cerrar' }).click();
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

  test('the Agent Builder offers the knowledge bases its author may use (D88 (35))', async () => {
    await page.getByRole('link', { name: 'Marketplace', exact: true }).first().click();
    await page.getByRole('link', { name: 'Nuevo agente' }).click();
    await expect(page).toHaveURL(/\/admin$/);
    const section = page.locator('#ab-kbs');
    await expect(section.getByRole('heading', { name: 'Knowledge bases' })).toBeVisible();
    await expect(section).toContainText('0 de 5 · solo aparecen las que puedes usar');
    await section.getByRole('button', { name: /^Políticas de RH/ }).click();
    await expect(section).toContainText('1 de 5 · solo aparecen las que puedes usar');
    await expect(section.getByRole('button', { name: /^Políticas de RH/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(section.getByRole('link', { name: 'Ver Knowledge Bases' })).toHaveAttribute(
      'href',
      '/knowledge',
    );
  });

  test('a bucket proposal is signed in Aprobaciones and pinned in the Bandeja (D88 (48), (49))', async () => {
    await page
      .getByRole('link', { name: /^Bandeja/ })
      .first()
      .click();
    const notices = page.getByRole('listbox', { name: 'Avisos' });
    await expect(
      notices.getByRole('option', { name: /Te piden aprobar: Cambiar el bucket de AWS Runbooks/ }),
    ).toBeVisible();
    await notices
      .getByRole('option', { name: /Te piden aprobar: Leer un bucket en Security Baseline/ })
      .click();
    await expect(
      page.getByText('Es de la cuenta de AWS de la instalación y no es de Mango.'),
    ).toBeVisible();
    await page.getByRole('button', { name: /Ver en Aprobaciones/ }).click();
    await expect(page).toHaveURL(/\/approvals\/pending\/[0-9A-Z]{26}$/);
    const detail = page.getByRole('region', { name: 'Detalle de la solicitud' });
    await expect(
      detail.getByRole('heading', { name: 'Leer un bucket en Security Baseline' }),
    ).toBeVisible();
    await detail.getByRole('button', { name: 'Aprobar' }).click();
    await detail.getByLabel(/Nota/).fill('Revisado con seguridad');
    await detail.getByRole('button', { name: 'Confirmar aprobación' }).click();
    await expect(page.getByText('Bucket aprobado · empieza la sincronización')).toBeVisible();
    await page.getByRole('tab', { name: 'Resueltas' }).click();
    const done = page.getByRole('listbox', { name: 'Solicitudes' });
    await done.getByRole('option', { name: /Leer un bucket en Security Baseline/ }).click();
    await expect(page.getByText('aprobó: «Revisado con seguridad»')).toBeVisible();
  });

  test('an answer from a knowledge base says where it searched and its sources (D88 (44))', async () => {
    await page.getByRole('link', { name: 'Chat', exact: true }).first().click();
    await page.locator('#chat-input').fill('¿Cuántos días de vacaciones tengo?');
    await page.locator('#chat-input').press('Enter');
    const answer = page.locator('article.msg-agent').last();
    await expect(answer.locator('.kb-step')).toHaveText('Buscó en Políticas de RH · 3 fragmentos', {
      timeout: 30_000,
    });
    const sources = answer.getByRole('region', { name: 'Fuentes' });
    await expect(sources.locator('.kb-cites-h')).toHaveText('Fuentes · Políticas de RH', {
      timeout: 30_000,
    });
    await expect(sources.locator('.kb-cite').first()).toHaveText('[1]documento-001.pdfp. 3');
    await expect(sources.getByRole('button')).toHaveCount(0);
  });

  test('no errors in the console but the refused bucket', () => {
    // The browser logs the 422 of the Mango bucket the API refused (second test); nothing else.
    expect(consoleErrors).toEqual([
      'Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)',
    ]);
  });
});
