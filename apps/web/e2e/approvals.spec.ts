import { expect, test, type Page } from '@playwright/test';

// Write tools with approval (D27) against the local mock: the inbox, a signature, the policies
// and the chat cards. The app keeps its tokens in memory only, so every step navigates inside
// the SPA. The mock has one user (central FinOps and administrator): the seeded requests of
// other people are the ones that can be signed.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

test('an approver signs a request and reads the policies', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Aprobaciones', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Aprobaciones' })).toBeVisible();

  const queue = page.getByRole('listbox', { name: 'Solicitudes' });
  await queue.getByRole('option').filter({ hasText: '0/2 firmas' }).first().click();
  const detail = page.getByRole('region', { name: 'Detalle de la solicitud' });
  // The call is shown as the API stored it, and what it does comes from the release.
  await expect(detail.getByText('aws-budgets.create_budget')).toBeVisible();
  await expect(detail.getByText('0 de 2 · deben ser personas distintas')).toBeVisible();

  await detail.getByRole('button', { name: 'Firmar', exact: true }).click();
  await detail.getByLabel(/^Nota/).fill('Revisado con el área');
  await detail.getByRole('button', { name: 'Confirmar firma' }).click();
  await expect(page.getByText('Firma registrada · falta otra aprobación')).toBeVisible();
  await expect(detail.getByText('Ya firmaste. Falta 1 firma de otra persona.')).toBeVisible();

  await page.getByRole('tab', { name: 'Políticas' }).click();
  await expect(
    page.getByText(/Ninguna tool de escritura se ejecuta sin confirmación/),
  ).toBeVisible();
  await expect(
    page.getByText('Hasta USD 500,00: confirma el usuario', { exact: true }),
  ).toBeVisible();
  // A proposal of another administrator can be decided here; the tool is locked meanwhile.
  await expect(
    page.getByRole('button', { name: 'Editar política de aws-budgets.create_budget' }),
  ).toBeDisabled();
});

test('the chat asks to confirm a write action, and holds a larger one for approvers', async ({
  page,
}) => {
  await signIn(page);
  const composer = page.getByRole('textbox').last();
  await composer.fill('crea un presupuesto de 300 para team-a');
  await composer.press('Enter');

  const confirm = page.getByRole('group', { name: 'Confirmar acción' });
  await expect(confirm).toContainText('¿Ejecutar esta acción?');
  await expect(confirm).toContainText('aws-budgets.create_budget · name=team-a, amount_usd=300');
  await confirm.getByRole('button', { name: 'Ejecutar' }).click();
  await expect(confirm).toContainText('Confirmada');
  await expect(confirm).toContainText('La acción se ejecutó.');
  await expect(confirm.getByRole('button')).toHaveCount(0);

  await composer.fill('crea un presupuesto de 9000 para plataforma');
  await composer.press('Enter');
  const held = page.getByRole('group', { name: /Aprobación APR-/ });
  await expect(held).toContainText('Requiere aprobación');
  await expect(held).toContainText('Tú la pediste: la aprueba otra persona.');
  // Who asked never signs from the chat: only cancels.
  await expect(held.getByRole('button', { name: /Firmar|Aprobar/ })).toHaveCount(0);
  await held.getByRole('button', { name: 'Cancelar solicitud' }).click();
  await expect(held).toContainText('Cancelada');
});

test('who asked runs an approved request from «Pendientes», and it moves to «Resueltas»', async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Aprobaciones', exact: true }).first().click();
  // No risk level exists in the product: the design shows no filter for it.
  await expect(page.getByRole('combobox', { name: 'Riesgo' })).toHaveCount(0);
  await page.getByRole('button', { name: /Listas para ejecutar/ }).click();

  const queue = page.getByRole('listbox', { name: 'Solicitudes' });
  await expect(queue.getByRole('option')).toHaveCount(1);
  await expect(queue.getByRole('option')).toContainText('Aprobada · sin ejecutar');
  await expect(queue.getByRole('img', { name: 'Lista para que la ejecutes' })).toBeVisible();
  const detail = page.getByRole('region', { name: 'Detalle de la solicitud' });
  await expect(detail).toContainText('aprobó · falta que la ejecutes');
  await expect(detail).toContainText(/Ejecútala antes de que venza · vence en/);
  await detail.getByRole('button', { name: 'Ejecutar' }).click();
  await expect(page.getByText(/APR-[0-9A-F]{8} ejecutada/)).toBeVisible();
  // Run, it no longer waits for anyone: it leaves the view and is filed under «Resueltas».
  await expect(queue).toHaveCount(0);

  await page.getByRole('tab', { name: 'Resueltas' }).click();
  await queue.getByRole('option').filter({ hasText: 'Ejecutada' }).click();
  await expect(detail).toContainText('la ejecutó');
});

test('on a narrow screen the detail replaces the list, with «Volver a la lista»', async ({
  page,
}) => {
  await signIn(page);
  // Opened from the sidebar at desktop width, then the window turns into a phone.
  await page.getByRole('link', { name: 'Aprobaciones', exact: true }).first().click();
  await page.setViewportSize({ width: 420, height: 900 });
  const queue = page.getByRole('listbox', { name: 'Solicitudes' });
  const detail = page.getByRole('region', { name: 'Detalle de la solicitud' });
  await expect(detail).toHaveCount(0);
  await queue.getByRole('option').first().click();
  await expect(queue).toHaveCount(0);
  await expect(detail.getByText('qué va a ejecutar')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
  await detail.getByRole('button', { name: 'Volver a la lista' }).click();
  await expect(queue).toBeVisible();
});

test('the chat shows the phase and the steps of the turn, a failed tool and a guardrail cut', async ({
  page,
}) => {
  await signIn(page);
  const composer = page.getByRole('textbox').last();
  await composer.fill('gasto del mes con tools en paralelo');
  await composer.press('Enter');
  const turn = page.getByRole('article').last();
  await expect(turn.getByText('Consultando 2 tools…')).toBeVisible();
  // The phase line carries its own indicator (decoration: the text is what gets announced).
  await expect(turn.locator('.ch-phase .ch-orb')).toHaveAttribute('aria-hidden', 'true');
  await turn.getByRole('button', { name: /pasos/ }).click();
  await expect(turn.getByText('Falló get_rightsizing_recommendations')).toBeVisible();
  await expect(turn.getByRole('button', { name: /pasos · 1 con error/ })).toBeVisible();
  // Once the answer ends, the steps give way to the tool group, which marks the failure.
  await expect(page.getByText('Respuesta completa')).toBeVisible({ timeout: 20_000 });
  await expect(turn.getByRole('button', { name: /pasos/ })).toHaveCount(0);
  await turn.getByRole('button', { name: /3 herramientas/ }).click();
  await expect(turn.locator('.tool-row .badge', { hasText: 'Falló' })).toHaveCount(1);

  await composer.fill('prueba de guardrail');
  await composer.press('Enter');
  await expect(
    page.getByText(/La respuesta se cortó porque infringía una regla de seguridad de Mango/),
  ).toBeVisible({ timeout: 20_000 });
});
