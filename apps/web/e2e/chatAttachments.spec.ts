import { expect, test, type Page } from '@playwright/test';

// Design round 40 (D116): the composer's files against the local mock. FinOps runs code in the
// mock, so it takes files; Savings Plans does not. The mock's demo words in a file name:
// «bloqueado» (blocked by the scan), «disfrazado» (not the type it says), «falla» (the first
// upload fails). Each file goes to the mock bucket by its signed POST, then «Revisando el
// archivo…» lasts a moment.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

/** In-app navigation (a reload would sign the user out). */
async function pushRoute(page: Page, path: string): Promise<void> {
  await page.evaluate(
    `window.history.pushState({}, '', ${JSON.stringify(path)});
     window.dispatchEvent(new PopStateEvent('popstate'));`,
  );
}

const file = (name: string, text = 'mes,servicio,costo\n2026-10,EC2,58300\n') => ({
  name,
  mimeType: 'application/octet-stream',
  buffer: Buffer.from(text),
});

/** What the browser logs for the mock bucket's planned failure («falla»). */
const EXPECTED_NETWORK = [
  /^Failed to load resource: the server responded with a status of 500 \(Internal Server Error\)$/,
];

test.describe.configure({ mode: 'serial' });

test.describe('Chat attachments', () => {
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

  test('a new chat sends its files once they are uploaded and scanned', async () => {
    await pushRoute(page, '/');
    await expect(page.getByRole('textbox', { name: 'Mensaje a FinOps' })).toBeVisible();
    const chips = page.locator('.composer-box .cr-chip');
    await page
      .locator('input[type="file"]')
      .setInputFiles([
        file('cur_octubre_2026.csv'),
        file('reporte_proveedor.html'),
        file('informe_bloqueado.pdf'),
        file('captura_disfrazado.png'),
      ]);
    await expect(chips).toHaveCount(4);
    await expect(page.getByText('Revisando el archivo…').first()).toBeVisible();
    const send = page.getByRole('button', { name: 'Enviar' });
    await expect(send).toBeDisabled();
    await expect(chips.nth(1)).toContainText('Tipo no permitido');
    await expect(chips.nth(2)).toContainText('Bloqueado por el escaneo');
    await expect(chips.nth(3)).toContainText('El contenido no es del tipo que dice');
    await expect(chips.nth(0)).toContainText('KB');
    await expect(
      page.getByText('Quita los archivos con problemas para enviar el mensaje.'),
    ).toBeVisible();
    for (const name of [
      'reporte_proveedor.html',
      'informe_bloqueado.pdf',
      'captura_disfrazado.png',
    ]) {
      await page.getByRole('button', { name: `Quitar ${name}` }).click();
    }
    await expect(chips).toHaveCount(1);
    await expect(send).toBeEnabled();

    await page.locator('#chat-input').fill('¿Qué servicio subió más en octubre?');
    await page.locator('#chat-input').press('Enter');
    // The new chat starts with the id its files were uploaded to.
    await expect(page).toHaveURL(/\/c\/[0-9a-f]{32}$/);
    const question = page.locator('.msg-user').last();
    await expect(question.locator('.cr-chip')).toContainText('cur_octubre_2026.csv');
    await expect(chips).toHaveCount(0);
    await expect(page.locator('.msg-agent').last()).toContainText('Recomendaciones', {
      timeout: 30_000,
    });

    // The history keeps the files of the question.
    const url = page.url();
    await pushRoute(page, '/');
    await pushRoute(page, new URL(url).pathname);
    await expect(page.locator('.msg-user .cr-chip').first()).toContainText('cur_octubre_2026.csv');
  });

  test('a failed upload is retried, and past 20 files the rest stay out', async () => {
    await pushRoute(page, '/');
    await page.locator('input[type="file"]').setInputFiles([file('cur_falla.csv')]);
    const chip = page.locator('.composer-box .cr-chip').first();
    await expect(chip).toContainText('No se pudo subir');
    await chip.getByRole('button', { name: 'Reintentar' }).click();
    await expect(chip).toContainText('KB');
    await expect(chip).not.toContainText('No se pudo subir');

    await page
      .locator('input[type="file"]')
      .setInputFiles(Array.from({ length: 22 }, (_, n) => file(`parte_${String(n)}.csv`)));
    await expect(page.locator('.composer-box .cr-chip')).toHaveCount(20);
    await expect(page.getByRole('alert')).toHaveText(
      'Puedes adjuntar hasta 20 archivos por mensaje. 3 se quedaron fuera.',
    );
  });

  test('files dropped on the conversation go to the composer', async () => {
    // Another chat first: the new chat of the previous test keeps its files until then.
    await page
      .getByRole('link', { name: /Gasto de EC2 del mes/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/c\/[0-9a-f]{32}$/);
    await expect(page.locator('.composer-box .cr-chip')).toHaveCount(0);
    await pushRoute(page, '/');
    await expect(page.locator('.composer-box .cr-chip')).toHaveCount(0);
    // Built in the page (the e2e have no DOM types): one CSV, as a drag from the desktop.
    const transfer = await page.evaluateHandle(`(() => {
      const data = new DataTransfer();
      data.items.add(new File(['a,b\\n1,2\\n'], 'presupuesto_2027.csv', { type: 'text/csv' }));
      return data;
    })()`);
    const main = page.locator('.chat-main');
    await main.dispatchEvent('dragover', { dataTransfer: transfer });
    await expect(page.locator('.chat-drop')).toContainText('Suelta los archivos para adjuntarlos');
    await expect(page.locator('.chat-drop')).toContainText('Hasta 20 archivos · 100 MB c/u');
    await main.dispatchEvent('drop', { dataTransfer: transfer });
    await expect(page.locator('.chat-drop')).toHaveCount(0);
    await expect(page.locator('.composer-box .cr-chip')).toContainText('presupuesto_2027.csv');
  });

  test('an agent without «Ejecutar código» says why, and a gone file is struck through', async () => {
    await pushRoute(page, '/');
    await page
      .getByRole('link', { name: /Savings Plans de agosto/ })
      .first()
      .click();
    const gone = page.locator('.msg-user .cr-chip.is-gone');
    await expect(gone).toContainText('cobertura_julio_2026.csv');
    await expect(gone).toContainText('Ya no disponible');
    await expect(gone).toHaveAttribute('title', 'Los adjuntos se guardan 90 días.');

    const attach = page.getByRole('button', { name: 'Adjuntar archivos (no disponible)' });
    await expect(attach).toHaveAttribute('aria-disabled', 'true');
    // Playwright waits for an aria-disabled button to be enabled; a person can press it.
    await attach.dispatchEvent('click');
    await expect(page.locator('#chat-input-why')).toHaveText(
      'Savings Plans no puede leer archivos: su versión no tiene «Ejecutar código». Quien lo administra puede activarlo en el Builder.',
    );
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
  });

  test('no unexpected errors in the console', () => {
    const unexpected = consoleErrors.filter(
      (text) => !EXPECTED_NETWORK.some((pattern) => pattern.test(text)),
    );
    expect(unexpected).toEqual([]);
  });
});
