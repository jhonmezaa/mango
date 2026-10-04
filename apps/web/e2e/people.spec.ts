import { expect, test, type Page } from '@playwright/test';

// Ajustes › Personas and General › Instalación (Claude Design, round of 2026-10-03) against the
// local mock, whose directory has usuario1–64@empresa.com and the mock administrator. The app
// keeps its tokens in memory only, so every step navigates inside the SPA.

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Correo').fill('mock-user@example.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('any-password-works-in-the-mock');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

async function openPeople(page: Page): Promise<void> {
  await signIn(page);
  await page.getByRole('button', { name: 'Ajustes', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeVisible();
  await page.getByRole('tab', { name: 'Personas' }).click();
  await expect(page.getByRole('list', { name: 'Personas del directorio' })).toBeVisible();
}

test('General opens on the installation, read-only', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Ajustes', exact: true }).first().click();
  // The mock has three administrators: the page stays on General.
  await expect(page.getByRole('heading', { name: 'Instalación' })).toBeVisible();
  await expect(page.getByText('v0.1.0', { exact: true })).toBeVisible();
  await expect(page.getByText('v0.1.0-g1a2b3c4')).toBeVisible();
  await expect(page.getByText('mango-example')).toBeVisible();
  await page.getByRole('button', { name: 'Autenticación' }).click();
  await expect(page.getByText('Dominios para registrarse')).toBeVisible();
  // The reset by email is gone: it is asked for on the person.
  await page.getByRole('button', { name: 'Ir a Personas →' }).click();
  await expect(page.getByRole('tab', { name: 'Personas' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('the directory lists, searches and pages the people', async ({ page }) => {
  await openPeople(page);
  const list = page.getByRole('list', { name: 'Personas del directorio' });
  await expect(list.getByRole('listitem')).toHaveCount(20);
  // People who signed up without a group go first, and are counted.
  await expect(list.getByRole('listitem').first()).toContainText('Sin acceso');
  await expect(
    page.getByText(/personas se registraron y aún no tienen acceso a nada\./),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Mostrar más' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(40);

  await page.getByRole('searchbox', { name: 'Buscar por correo' }).fill('usuario6@');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('usuario6@empresa.com');
  // Two groups and how many more: the rest are in the panel of the person.
  await expect(list).toContainText('bu-retail');
  await expect(list).toContainText('+1');
  await page.getByRole('searchbox', { name: 'Buscar por correo' }).fill('nadie');
  await expect(page.getByText('Ningún correo empieza por «nadie».')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Buscar por correo' }).fill('');

  await page.getByRole('button', { name: 'Deshabilitadas' }).click();
  await expect(list.getByRole('listitem').first()).toContainText('Deshabilitada');
  // What another administrator proposed is listed with what they wrote, as text.
  const changes = page.getByRole('region', { name: 'Cambios de personas' });
  await expect(changes).toContainText('Dar mango-admin a usuario2@empresa.com');
  await expect(changes).toContainText('<script>alert(1)</script> Cubre las aprobaciones');
});

test('a normal group is applied at once and mango-admin waits for another administrator', async ({
  page,
}) => {
  await openPeople(page);
  await page.getByRole('searchbox', { name: 'Buscar por correo' }).fill('usuario4@');
  await page.getByRole('button', { name: 'Gestionar usuario4@empresa.com' }).click();
  const panel = page.getByRole('dialog', { name: 'Persona usuario4@empresa.com' });
  const select = panel.getByRole('combobox', { name: 'Agregar a un grupo' });

  await select.selectOption('seguridad');
  await panel.getByRole('button', { name: 'Agregar', exact: true }).click();
  await expect(page.getByText('Grupo agregado')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Quitar seguridad' })).toBeVisible();

  await select.selectOption('mango-admin');
  const send = panel.getByRole('button', { name: 'Enviar a aprobación' });
  await send.click();
  await expect(panel.getByText('Escribe el motivo')).toBeVisible();
  await panel.getByLabel('Motivo', { exact: true }).fill('Cubre las aprobaciones del área');
  await send.click();
  await expect(page.getByText('Propuesta enviada · la debe aprobar otro admin')).toBeVisible();
  // Not applied: it waits in the panel and in the list of changes.
  await expect(panel.getByText('Agregar · pendiente de aprobación')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Quitar mango-admin' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  const changes = page.getByRole('region', { name: 'Cambios de personas' });
  const mine = changes.getByRole('article').filter({ hasText: 'usuario4@empresa.com' });
  await expect(mine).toContainText('Dar mango-admin a usuario4@empresa.com');
  await expect(mine).toContainText('Tu propuesta');
  // Who proposed only withdraws.
  await expect(mine.getByRole('button', { name: 'Aprobar' })).toHaveCount(0);
  await expect(mine.getByRole('button', { name: 'Retirar' })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Personas del directorio' }).getByText('Cambio pendiente'),
  ).toBeVisible();
});

test('a person of any company domain is invited, never a public address', async ({ page }) => {
  await openPeople(page);
  await page.getByRole('button', { name: 'Invitar persona' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invitar persona' });
  const email = dialog.getByLabel('Correo');
  const submit = dialog.getByRole('button', { name: 'Enviar invitación' });

  await email.fill('ana@gmail.com');
  await submit.click();
  await expect(
    dialog.getByText('Los correos públicos no se aceptan. Usa el correo de la empresa.'),
  ).toBeVisible();
  // The sensitive groups are not offered: there is more than one administrator.
  await expect(dialog.getByRole('button', { name: 'mango-admin' })).toHaveCount(0);

  await email.fill('persona.nueva@otra-empresa.com');
  await dialog.getByRole('button', { name: 'bu-finanzas' }).click();
  await submit.click();
  await expect(
    page.getByText('Invitación enviada · recibirá una contraseña temporal por correo'),
  ).toBeVisible();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Invitadas' }).click();
  const invited = page
    .getByRole('list', { name: 'Personas del directorio' })
    .getByRole('listitem')
    .filter({ hasText: 'persona.nueva@otra-empresa.com' });
  await expect(invited).toContainText('Invitada · contraseña temporal');
  await expect(invited).toContainText('bu-finanzas');

  // The same email again: the API says it is in the directory (to administrators only).
  await page.getByRole('button', { name: 'Invitar persona' }).click();
  await dialog.getByLabel('Correo').fill('persona.nueva@otra-empresa.com');
  await dialog.getByRole('button', { name: 'Enviar invitación' }).click();
  await expect(
    dialog.getByText(
      'Ese correo ya está en el directorio. Ábrelo en la lista para cambiar sus grupos.',
    ),
  ).toBeVisible();
});
