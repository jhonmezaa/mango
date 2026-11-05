import { expect, test, type Page } from '@playwright/test';

// Tickets (D112, design tickets.jsx round 37) against the local mock: the sidebar entry, the
// board with «Por aprobar», search, a new ticket, its panel (comment in Markdown, assign, move)
// and the confirmation card of the tickets tool in the chat, whose ticket then shows up. The
// app keeps its tokens in memory only, so every step navigates inside the SPA. The mock keeps
// its state between tests: each test writes what it reads.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function openTickets(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  await nav.getByRole('link', { name: 'Tickets', exact: true }).click();
  await expect(page).toHaveURL(/\/tickets$/);
  await expect(page.getByRole('region', { name: 'Abierto' })).toBeVisible();
}

test('Tickets lists the board, creates a ticket and works on it from its panel', async ({
  page,
}) => {
  await signIn(page);
  await openTickets(page);

  // «Por aprobar» comes from an open request of its conversation; its column takes no «+».
  const pending = page.getByRole('region', { name: 'Por aprobar' });
  await expect(pending.getByText('Crear el presupuesto de plataforma-q4')).toBeVisible();
  await expect(pending.getByText('Espera aprobación')).toBeVisible();
  await expect(pending.getByRole('button', { name: /Nuevo ticket en/ })).toHaveCount(0);
  // A stored title with HTML is text.
  await expect(page.getByText('Ticket con <b>HTML</b> en el título')).toBeVisible();

  await page.getByRole('searchbox', { name: 'Buscar tickets' }).fill('octubre');
  await expect(page.getByText('1 ticket', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Limpiar' }).click();

  // A new ticket, assigned to me.
  await page.getByRole('button', { name: 'Nuevo ticket', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Nuevo ticket' });
  await create.getByRole('textbox', { name: 'Título' }).fill('Revisar etiquetas de costo e2e');
  await create.getByRole('combobox', { name: 'Prioridad' }).selectOption('high');
  await create.getByRole('combobox', { name: 'Asignar a' }).selectOption('me');
  await create.getByRole('button', { name: 'Crear ticket' }).click();
  await expect(page.getByText(/^Ticket [a-z2-7]{8} creado$/)).toBeVisible();
  await expect(create).toHaveCount(0);

  await page.getByRole('button', { name: /Revisar etiquetas de costo e2e/ }).click();
  await expect(page).toHaveURL(/\/tickets\/[a-z2-7]{12}$/);
  const panel = page.getByRole('dialog').filter({ hasText: 'Revisar etiquetas de costo e2e' });
  await expect(
    panel.getByRole('heading', { name: 'Revisar etiquetas de costo e2e' }),
  ).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'Herramientas · 0' })).toBeVisible();

  // A comment in Markdown, without raw HTML.
  await panel.getByRole('textbox', { name: 'Comentario' }).fill('**Listo** <img src=x>');
  await panel.getByRole('button', { name: 'Comentar' }).click();
  await expect(panel.locator('.tk-cm-body strong')).toHaveText('Listo');
  await expect(panel.locator('.tk-cm-body img')).toHaveCount(0);

  // Move it and see it in the activity.
  await panel.getByRole('combobox', { name: 'Estado' }).selectOption('in_progress');
  await expect(page.getByText(/^[a-z2-7]{8} → En curso$/)).toBeVisible();
  await panel.getByRole('tab', { name: 'Actividad' }).click();
  await expect(panel.getByText('cambió el estado a en curso')).toBeVisible();

  await panel.getByRole('button', { name: 'Cerrar' }).click();
  await expect(page).toHaveURL(/\/tickets$/);
  await expect(page.getByRole('region', { name: 'En curso' })).toContainText(
    'Revisar etiquetas de costo e2e',
  );
});

test('a ticket «Por aprobar» only leaves as resolved, and an unknown one cannot be seen', async ({
  page,
}) => {
  await signIn(page);
  await openTickets(page);
  await page.getByRole('button', { name: /Crear el presupuesto de plataforma-q4/ }).click();
  const panel = page.getByRole('dialog').filter({ hasText: 'Crear el presupuesto' });
  const status = panel.getByRole('combobox', { name: 'Estado' });
  await expect(status.getByRole('option', { name: 'Abierto' })).toBeDisabled();
  await expect(status.getByRole('option', { name: 'Resuelto' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Revisar en Aprobaciones' }).click();
  await expect(page).toHaveURL(/\/approvals\/pending\/[0-9a-f]{32}$/);

  // A link to a ticket that is not visible (the mock answers 404).
  await page
    .getByRole('navigation', { name: 'Navegación principal' })
    .getByRole('link', { name: 'Tickets', exact: true })
    .click();
  await page.getByRole('button', { name: /mock-gone/ }).click();
  await expect(page.getByText('No puedes ver este ticket')).toBeVisible();
  await page.getByRole('button', { name: 'Volver a Tickets' }).click();
  await expect(page).toHaveURL(/\/tickets$/);
});

test('the chat confirms the tickets tool with the ticket it writes', async ({ page }) => {
  await signIn(page);
  const composer = page.getByRole('textbox').last();
  await composer.fill('abre un ticket por el aumento de costo');
  await composer.press('Enter');

  const confirm = page.getByRole('group', { name: 'Confirmar acción' }).last();
  await expect(confirm).toContainText(
    'Crea el ticket «Revisar el aumento de costo de <b>prod-web</b>»',
  );
  await expect(confirm).toContainText('mango-tickets.create_ticket · title=');
  await confirm.getByRole('button', { name: 'Ejecutar' }).click();
  await expect(confirm).toContainText('Confirmada');

  await composer.fill('comenta en el ticket que ya lo revisé');
  await composer.press('Enter');
  const comment = page.getByRole('group', { name: 'Confirmar acción' }).last();
  await expect(comment).toContainText(
    /Comenta en el ticket [a-z2-7]{8} · Revisar el aumento de costo de Bedrock en prod-web/,
  );
  await comment.getByRole('button', { name: 'Cancelar' }).click();
  await expect(comment).toContainText('Cancelada');

  await openTickets(page);
  await expect(
    page
      .getByRole('region', { name: 'Abierto' })
      .getByText('Revisar el aumento de costo de <b>prod-web</b>'),
  ).toBeVisible();
});
