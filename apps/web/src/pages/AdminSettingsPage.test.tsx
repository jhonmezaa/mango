import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import type { RuntimeConfig } from '../config/runtimeConfig';
import { ADMIN_ID, ORGANIZATION, businessUnitsFixture } from '../test/adminFixtures';
import { baseMe, sessionValue, testConfig } from '../test/fixtures';
import { TestProviders } from '../test/TestProviders';
import { AdminSettingsPage } from './AdminSettingsPage';

const FUTURE = '2999-01-01T00:00:00Z';

function first<T>(list: readonly T[]): T {
  const [item] = list;
  if (item === undefined) throw new Error('empty fixture');
  return item;
}

/** What the page itself asks for through the generated client, whatever the tab under test. */
const INSTALLATION = {
  name: 'mango-example',
  version: '0.1.0',
  organization_id: 'o-exampleorg1',
  management_account_id: '111111111111',
  alerts_emails: ['alertas@example.com'],
  sign_up_domains: ['example.com'],
  first_admins: ['ana.perez@example.com', 'otra.admin@example.com'],
};
const directory = (admins: number) => ({
  items: [],
  next_cursor: null,
  pending: 0,
  admins,
  with_access: 3,
  incomplete: false,
});

function renderPage(
  api: Partial<ApiClient>,
  isAdmin = true,
  tab: string | null = 'Áreas y OUs',
  config: Partial<RuntimeConfig> = {},
  page: { admins?: number; installation?: typeof INSTALLATION | Error } = {},
) {
  const units = businessUnitsFixture();
  // Far-future expiry so the fixtures stay "pending" whatever today's date is.
  units.pending = units.pending.map((change) => ({ ...change, expires_at: FUTURE }));
  const { call: tabCall = vi.fn(memberAccess([])), ...rest } = api;
  const installation = page.installation ?? INSTALLATION;
  // The page reads the directory (to open on Personas with a single administrator) and the
  // installation; everything else goes to the `call` of the test.
  const call = vi.fn((operation: string, ...args: unknown[]) => {
    if (operation === 'searchPeople') return Promise.resolve(directory(page.admins ?? 2));
    if (operation === 'getMemberChanges') return Promise.resolve({ items: [] });
    if (operation === 'getInstallation') {
      return installation instanceof Error
        ? Promise.reject(installation)
        : Promise.resolve(installation);
    }
    return (tabCall as (...all: unknown[]) => Promise<unknown>)(operation, ...args);
  });
  const result = render(
    <TestProviders
      session={sessionValue({
        config: {
          ...testConfig,
          aiPolicyUrl: 'https://intranet.example.com/politica-ia',
          ...config,
        },
        api: {
          getBusinessUnits: vi.fn(() => Promise.resolve(units)),
          getOrganization: vi.fn(() => Promise.resolve(ORGANIZATION)),
          listMfaResets: vi.fn(() => Promise.resolve([])),
          ...rest,
          call,
        } as unknown as ApiClient,
        me: { ...baseMe, user_id: ADMIN_ID, business_unit: 'finanzas', is_admin: isAdmin },
      })}
    >
      <AdminSettingsPage />
    </TestProviders>,
  );
  // The design opens on General; most tests exercise another tab.
  if (isAdmin && tab) fireEvent.click(screen.getByRole('tab', { name: tab }));
  return { ...result, call };
}

type MemberAccount = { account_id: string; name: string; status: string };

/** `api.call` that only answers the member account check. */
function memberAccess(
  accounts: MemberAccount[] | Error,
  { total, identity = true }: { total?: number; identity?: boolean } = {},
) {
  return (operation: string) =>
    operation !== 'memberAccessCheck'
      ? Promise.reject(new Error(`unexpected ${operation}`))
      : accounts instanceof Error
        ? Promise.reject(accounts)
        : Promise.resolve({
            checked_at: '2026-10-02T10:00:00Z',
            accounts,
            truncated: total !== undefined && total > accounts.length,
            total: total ?? accounts.length,
            identity_required: accounts.length > 0 ? identity : null,
          });
}

async function card(heading: RegExp) {
  const title = await screen.findByRole('heading', { name: heading });
  return title.closest('article') as HTMLElement;
}

describe('AdminSettingsPage', () => {
  it('opens on General, with every tab of the design available', async () => {
    renderPage({}, true, null);
    expect(await screen.findByRole('tab', { name: 'General' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Design order: Personas sits between General and Grupos.
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'General',
      'Personas',
      'Grupos',
      'Áreas y OUs',
      'Conectividad',
    ]);
    expect(within(screen.getByRole('tablist')).queryByText('Próximamente')).toBeNull();
    expect(
      screen.getByText(
        'Instalación, autenticación, personas y grupos, áreas de negocio y conectividad con AWS.',
      ),
    ).toBeInTheDocument();
    // More than one administrator: the page stays on General.
    expect(await screen.findByRole('heading', { name: 'Instalación' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens on Personas while the installation has a single administrator', async () => {
    renderPage({}, true, null, {}, { admins: 1 });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Personas' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
    expect(
      await screen.findByRole('heading', { name: 'Primeros pasos de esta instalación' }),
    ).toBeInTheDocument();
  });

  it('keeps the tab the person picked when the directory answers later', async () => {
    renderPage({}, true, 'Conectividad', {}, { admins: 1 });
    expect(await screen.findByText('Conexión con AWS')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Conectividad' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
    expect(screen.getByRole('tab', { name: 'Personas' })).toHaveAttribute('aria-selected', 'false');
  });

  it('renders the mapping and untrusted text (OU names, reasons, emails) as text', async () => {
    const { container } = renderPage({});
    expect(
      await screen.findByText('Versión 3 · 2 de 20 áreas · cada área solo ve el gasto de sus OUs'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Tu área').length).toBeGreaterThan(0);
    const other = await card(/otra\.admin@example\.com/);
    expect(other).toHaveTextContent('<script>alert(1)</script> Datos pasa a Retail');
    const myArea = await card(/admin-3/);
    expect(myArea).toHaveTextContent('Sandbox <img src=x onerror=alert(1)>');
    expect(container.querySelector('script, img')).toBeNull();
    expect(
      screen.getByText(
        '3 de 10 · los propone un administrador y los aprueba otro distinto · vencen a los 7 días',
      ),
    ).toBeInTheDocument();
  });

  it('explains what the API will refuse: own proposal, own area', async () => {
    renderPage({});
    const mine = await card(/Tu propuesta/);
    expect(within(mine).getByRole('button', { name: 'Retirar' })).toBeEnabled();
    expect(within(mine).queryByRole('button', { name: /Aprobar/ })).toBeNull();

    const myArea = await card(/admin-3/);
    const reject = within(myArea).getByRole('button', { name: /Rechazar/ });
    const approve = within(myArea).getByRole('button', { name: /Aprobar/ });
    expect(reject).toBeDisabled();
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(
      'Toca tu área (finanzas): no puedes aprobarla ni rechazarla.',
    );

    const other = await card(/otra\.admin/);
    expect(within(other).getByRole('button', { name: /Aprobar/ })).toBeEnabled();
  });

  it('marks a proposal on an older version as out of date and disables approve', async () => {
    const units = businessUnitsFixture();
    units.pending = [{ ...first(units.pending), base_version: 2, expires_at: FUTURE }];
    renderPage({ getBusinessUnits: vi.fn(() => Promise.resolve(units)) });
    const other = await card(/otra\.admin/);
    expect(within(other).getByText('Desactualizada')).toBeInTheDocument();
    expect(within(other).getByRole('button', { name: /Aprobar/ })).toHaveAccessibleDescription(
      /Se hizo sobre la versión 2 y la vigente es la 3/,
    );
  });

  it('approves from a dialog with the diff and the version bump', async () => {
    const user = userEvent.setup();
    const updated = businessUnitsFixture({ version: 4, pending: [] });
    const approveBusinessUnitChange = vi.fn(() => Promise.resolve(updated));
    renderPage({ approveBusinessUnitChange });
    await user.click(within(await card(/otra\.admin/)).getByRole('button', { name: /Aprobar/ }));
    const dialog = screen.getByRole('dialog', { name: 'Aprobar cambio del mapeo' });
    expect(dialog).toHaveTextContent('Área modificada');
    expect(dialog).toHaveTextContent('de la versión 3 a la 4');
    await user.click(within(dialog).getByRole('button', { name: 'Aprobar cambio' }));
    expect(approveBusinessUnitChange).toHaveBeenCalledWith('CHG-OTHER');
    expect(await screen.findByText('Cambio aprobado · mapeo en versión 4')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('locks the approval when another admin changed the mapping (409) and reloads', async () => {
    const user = userEvent.setup();
    const getBusinessUnits = vi.fn(() =>
      Promise.resolve({
        ...businessUnitsFixture(),
        pending: businessUnitsFixture().pending.map((c) => ({ ...c, expires_at: FUTURE })),
      }),
    );
    renderPage({
      getBusinessUnits,
      approveBusinessUnitChange: vi.fn(() =>
        Promise.reject(new ApiError(409, 'version_conflict', 'x')),
      ),
    });
    await user.click(within(await card(/otra\.admin/)).getByRole('button', { name: /Aprobar/ }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Aprobar cambio' }));
    expect(
      await within(dialog).findByText('Otro administrador cambió el mapeo'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Aprobar cambio' })).toBeNull();
    expect(within(dialog).getAllByRole('button', { name: 'Cerrar' }).length).toBeGreaterThan(0);
    expect(getBusinessUnits).toHaveBeenCalledTimes(2);
  });

  it('shows audit_unavailable from the API without applying anything', async () => {
    const user = userEvent.setup();
    renderPage({
      approveBusinessUnitChange: vi.fn(() =>
        Promise.reject(new ApiError(503, 'audit_unavailable', 'x')),
      ),
    });
    await user.click(within(await card(/otra\.admin/)).getByRole('button', { name: /Aprobar/ }));
    await user.click(screen.getByRole('button', { name: 'Aprobar cambio' }));
    expect(
      await screen.findByText('No se pudo registrar la auditoría; el cambio no se aplicó'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Aprobar cambio' })).toBeEnabled();
  });

  it('rejects with a required reason and a live counter', async () => {
    const user = userEvent.setup();
    const rejectBusinessUnitChange = vi.fn(() =>
      Promise.resolve(businessUnitsFixture({ pending: [] })),
    );
    renderPage({ rejectBusinessUnitChange });
    await user.click(within(await card(/otra\.admin/)).getByRole('button', { name: /Rechazar/ }));
    const dialog = screen.getByRole('dialog', { name: 'Rechazar cambio del mapeo' });
    await user.click(within(dialog).getByRole('button', { name: 'Rechazar propuesta' }));
    expect(within(dialog).getByText('Escribe el motivo del rechazo')).toBeInTheDocument();
    expect(rejectBusinessUnitChange).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText('Motivo del rechazo'), 'No aplica');
    expect(within(dialog).getByText('9 / 500')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Rechazar propuesta' }));
    expect(rejectBusinessUnitChange).toHaveBeenCalledWith('CHG-OTHER', 'No aplica');
    expect(await screen.findByText('Propuesta rechazada')).toBeInTheDocument();
  });

  it('withdraws your own proposal through the withdraw endpoint, without a reason', async () => {
    const user = userEvent.setup();
    const withdrawBusinessUnitChange = vi.fn(() =>
      Promise.resolve(businessUnitsFixture({ pending: [] })),
    );
    const rejectBusinessUnitChange = vi.fn();
    renderPage({ withdrawBusinessUnitChange, rejectBusinessUnitChange });
    await user.click(within(await card(/Tu propuesta/)).getByRole('button', { name: 'Retirar' }));
    const dialog = screen.getByRole('dialog', { name: '¿Retirar tu propuesta?' });
    await user.click(within(dialog).getByRole('button', { name: 'Retirar propuesta' }));
    expect(withdrawBusinessUnitChange).toHaveBeenCalledWith('CHG-MINE');
    expect(rejectBusinessUnitChange).not.toHaveBeenCalled();
    expect(await screen.findByText('Propuesta retirada')).toBeInTheDocument();
  });

  it('disables "Proponer cambio" at 10 pending proposals and says why', async () => {
    const base = businessUnitsFixture();
    const pending = Array.from({ length: 10 }, (_, index) => ({
      ...first(base.pending),
      change_id: `CHG-${String(index)}`,
      expires_at: FUTURE,
    }));
    renderPage({ getBusinessUnits: vi.fn(() => Promise.resolve({ ...base, pending })) });
    const propose = await screen.findByRole('button', { name: /Proponer cambio/ });
    expect(propose).toBeDisabled();
    expect(propose).toHaveAccessibleDescription(
      'Hay 10 propuestas pendientes, el máximo. Aprueba, rechaza o retira alguna para proponer otra.',
    );
  });

  it('proposes a change: no-op is refused locally, server errors are shown', async () => {
    const user = userEvent.setup();
    const proposeBusinessUnits = vi.fn(() => Promise.reject(new ApiError(400, 'unknown_ou', 'x')));
    renderPage({ proposeBusinessUnits });
    await user.click(await screen.findByRole('button', { name: /Proponer cambio/ }));
    const dialog = screen.getByRole('dialog', { name: 'Proponer cambio del mapeo' });
    // Own area is read-only in the editor.
    expect(
      within(dialog).getByText('Es tu área: no puedes proponer cambios sobre ella.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Enviar propuesta' }));
    expect(within(dialog).getByText('No hay cambios que proponer')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Eliminar área retail' }));
    expect(within(dialog).getByText('Área eliminada')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Motivo del cambio'), 'Retail se cierra');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar propuesta' }));
    expect(proposeBusinessUnits).toHaveBeenCalledWith({
      base_version: 3,
      units: { finanzas: ['ou-a1b2-22222222'] },
      reason: 'Retail se cierra',
    });
    expect(
      await within(dialog).findByText('Alguna OU no existe en la organización'),
    ).toBeInTheDocument();
  });

  it('refuses to send an area without OUs and says which ones', async () => {
    const user = userEvent.setup();
    const proposeBusinessUnits = vi.fn(() => Promise.resolve({ change_id: 'c-new' }));
    renderPage({ proposeBusinessUnits });
    await user.click(await screen.findByRole('button', { name: /Proponer cambio/ }));
    const dialog = screen.getByRole('dialog', { name: 'Proponer cambio del mapeo' });
    await user.click(within(dialog).getByRole('button', { name: /^Quitar / }));
    const hint = within(dialog).getByText('Agrega al menos una OU.');
    expect(hint).toHaveClass('g-hint');
    await user.type(within(dialog).getByLabelText('Motivo del cambio'), 'Retail sin cuentas');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar propuesta' }));

    expect(proposeBusinessUnits).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Agrega al menos una OU')).toBeInTheDocument();
    expect(
      within(dialog).getByText('El área retail no tiene OUs. Cada área necesita al menos una.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Agrega al menos una OU.')).toHaveClass('g-err');

    // Removing the empty area makes the draft valid again.
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar área retail' }));
    expect(within(dialog).queryByText('Agrega al menos una OU')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Enviar propuesta' }));
    expect(proposeBusinessUnits).toHaveBeenCalledWith(
      expect.objectContaining({ units: { finanzas: ['ou-a1b2-22222222'] } }),
    );
  });

  it('locks the editor on a 409 and never resends the draft on the newer version', async () => {
    const user = userEvent.setup();
    const pending = businessUnitsFixture().pending.map((c) => ({ ...c, expires_at: FUTURE }));
    // First load on v3; the refresh after the conflict sees v4 (another change was approved).
    const getBusinessUnits = vi
      .fn()
      .mockResolvedValueOnce({ ...businessUnitsFixture(), pending })
      .mockResolvedValue({ ...businessUnitsFixture({ version: 4 }), pending });
    const proposeBusinessUnits = vi.fn(() =>
      Promise.reject(new ApiError(409, 'version_conflict', 'x')),
    );
    renderPage({ getBusinessUnits, proposeBusinessUnits });
    await user.click(await screen.findByRole('button', { name: /Proponer cambio/ }));
    const dialog = screen.getByRole('dialog', { name: 'Proponer cambio del mapeo' });
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar área retail' }));
    await user.type(within(dialog).getByLabelText('Motivo del cambio'), 'Retail se cierra');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar propuesta' }));
    expect(proposeBusinessUnits).toHaveBeenCalledWith(expect.objectContaining({ base_version: 3 }));
    expect(
      await within(dialog).findByText('Otro administrador cambió el mapeo'),
    ).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(getBusinessUnits).toHaveBeenCalledTimes(2);
    });
    // Only "Cerrar": the draft was built on v3 and must be redone on the current version.
    expect(within(dialog).queryByRole('button', { name: 'Enviar propuesta' })).toBeNull();
    expect(within(dialog).getAllByRole('button', { name: 'Cerrar' }).length).toBeGreaterThan(0);
    expect(within(dialog).getByText('Sobre la versión 3')).toBeInTheDocument();
    expect(proposeBusinessUnits).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['reject', /otra\.admin/, /Rechazar/, 'Rechazar cambio del mapeo', 'Rechazar propuesta'],
    ['withdraw', /Tu propuesta/, 'Retirar', '¿Retirar tu propuesta?', 'Retirar propuesta'],
  ] as const)(
    'locks the %s dialog when the proposal is already closed (409)',
    async (_action, heading, open, title, submit) => {
      const user = userEvent.setup();
      const closed = vi.fn(() =>
        Promise.reject(new ApiError(409, 'version_conflict', 'already closed')),
      );
      renderPage({ rejectBusinessUnitChange: closed, withdrawBusinessUnitChange: closed });
      await user.click(within(await card(heading)).getByRole('button', { name: open }));
      const dialog = screen.getByRole('dialog', { name: title });
      const reason = within(dialog).queryByLabelText('Motivo del rechazo');
      if (reason) await user.type(reason, 'No aplica');
      await user.click(within(dialog).getByRole('button', { name: submit }));
      expect(
        await within(dialog).findByText('Otro administrador cambió el mapeo'),
      ).toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: submit })).toBeNull();
      expect(within(dialog).getAllByRole('button', { name: 'Cerrar' }).length).toBeGreaterThan(0);
      expect(closed).toHaveBeenCalledTimes(1);
    },
  );

  it('adds an OU from the organization picker', async () => {
    const user = userEvent.setup();
    renderPage({});
    await user.click(await screen.findByRole('button', { name: /Proponer cambio/ }));
    const dialog = screen.getByRole('dialog', { name: 'Proponer cambio del mapeo' });
    await user.click(within(dialog).getByRole('button', { name: /Agregar OU/ }));
    const picker = within(dialog).getByRole('dialog', { name: 'Agregar OU a retail' });
    expect(within(picker).getByRole('option', { name: /Retail/ })).toBeDisabled();
    await user.click(within(picker).getByRole('option', { name: /Datos/ }));
    expect(within(dialog).getByText('Área modificada')).toBeInTheDocument();
  });

  it('keeps working without the organization tree (IDs only, typed OUs)', async () => {
    const user = userEvent.setup();
    renderPage({ getOrganization: vi.fn(() => Promise.reject(new ApiError(502, 'x', 'x'))) });
    expect(await screen.findByText('No se pudo leer la organización de AWS')).toBeInTheDocument();
    expect(screen.queryByText('Finanzas')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Proponer cambio/ }));
    await user.click(screen.getByRole('button', { name: /Agregar OU/ }));
    const input = screen.getByLabelText('Id de la OU para retail');
    await user.type(input, 'nope{Enter}');
    expect(screen.getByText('Formato: ou-xxxx-xxxxxxxx')).toBeInTheDocument();
  });

  it('shows the design access state to non-admins without calling the API', () => {
    const getBusinessUnits = vi.fn();
    renderPage({ getBusinessUnits }, false);
    expect(screen.getByText('No tienes acceso a esta sección')).toBeInTheDocument();
    expect(getBusinessUnits).not.toHaveBeenCalled();
  });
});

async function openAuth() {
  const nav = await screen.findByRole('navigation', { name: 'Secciones de General' });
  fireEvent.click(within(nav).getByRole('button', { name: 'Autenticación' }));
  return nav;
}

describe('General › Instalación', () => {
  it('opens General on the installation, read-only and as text', async () => {
    const { container } = renderPage(
      {},
      true,
      null,
      {},
      {
        installation: {
          ...INSTALLATION,
          name: '<img src=x onerror=alert(1)>',
          first_admins: ['<b>ana</b>@example.com'],
        },
      },
    );
    expect(await screen.findByRole('heading', { name: 'Instalación' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Secciones de General' });
    expect(within(nav).getByRole('button', { name: 'Instalación' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getAllByText('Próximamente')).toHaveLength(7);
    expect(await screen.findByText('v0.1.0')).toBeInTheDocument();
    // The product has no identifier of the publication.
    expect(screen.queryByText(/Publicación/)).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(screen.getByText('o-exampleorg1')).toBeInTheDocument();
    expect(screen.getByText('111111111111')).toBeInTheDocument();
    expect(screen.getByText('alertas@example.com')).toBeInTheDocument();
    expect(screen.getByText('<b>ana</b>@example.com')).toBeInTheDocument();
    expect(screen.getByText('Se instaló con uno solo')).toBeInTheDocument();
    expect(container.querySelector('img, b')).toBeNull();
    // Nothing of the section can be edited.
    expect(
      container.querySelector('.set-body input, .set-body select, .set-body textarea'),
    ).toBeNull();
  });

  it('shows what the installation did not give as «—» and a missing version as «Sin versión»', async () => {
    renderPage(
      {},
      true,
      null,
      {},
      {
        installation: {
          ...INSTALLATION,
          version: null,
          organization_id: null,
          management_account_id: null,
          alerts_emails: [],
          first_admins: [],
        } as unknown as typeof INSTALLATION,
      },
    );
    expect(await screen.findByText('Sin versión')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(4);
    expect(screen.queryByText('Se instaló con uno solo')).toBeNull();
  });

  it('says the installation could not be loaded and retries', async () => {
    const user = userEvent.setup();
    const { call } = renderPage(
      {},
      true,
      null,
      {},
      {
        installation: new ApiError(502, 'upstream_error', 'arn:aws:iam::1:role/x'),
      },
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No se pudieron cargar los datos de la instalación.',
    );
    expect(screen.queryByText(/arn:aws/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => {
      expect(call.mock.calls.filter(([name]) => name === 'getInstallation')).toHaveLength(2);
    });
  });
});

describe('General › Autenticación', () => {
  it('shows the authentication of the installation read-only', async () => {
    renderPage({}, true, null);
    const nav = await openAuth();
    expect(await screen.findByRole('heading', { name: 'Autenticación' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Autenticación' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getAllByText('Próximamente')).toHaveLength(7);
    expect(screen.getByText(testConfig.userPoolId)).toBeInTheDocument();
    expect(screen.getByText(testConfig.region)).toBeInTheDocument();
    expect(screen.getByText(testConfig.clientId)).toBeInTheDocument();
    expect(
      screen.getByText('Mínimo 14 caracteres, con mayúsculas, minúsculas, números y símbolos'),
    ).toBeInTheDocument();
    const policy = screen.getByRole('link', { name: /politica-ia/ });
    expect(policy).toHaveAttribute('href', 'https://intranet.example.com/politica-ia');
    expect(policy).toHaveAttribute('target', '_blank');
    expect(policy).toHaveAttribute('rel', 'noopener noreferrer');
    // Current values come from config.json; a customer installation always requires MFA.
    expect(
      screen.getByText(
        'Cognito gestiona las cuentas. MFA, plan del directorio y dominios de registro vienen de la instalación y no se editan aquí.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Obligatorio')).toBeInTheDocument();
    expect(screen.getByText('Fijo')).toBeInTheDocument();
    expect(screen.getByText('Siempre obligatorio · viene de la instalación')).toBeInTheDocument();
    expect(screen.getByText('12 h')).toBeInTheDocument();
    expect(screen.getByText('Sin IdP · solo correo y contraseña')).toBeInTheDocument();
    expect(screen.getByText('Dominios para registrarse')).toBeInTheDocument();
    expect(
      screen.getByText('Viene de la instalación · los correos públicos se rechazan'),
    ).toBeInTheDocument();
    expect(screen.getByText('example.com')).toBeInTheDocument();
    // `config.json` does not carry the plan of the directory: the row is not shown.
    expect(screen.queryByText('Plan del directorio')).toBeNull();
    // D21 has no backend: "Proponer cambio" is "Próximamente" and there are no sample proposals.
    expect(screen.queryByText('Proponer cambio de MFA (app autenticadora)')).toBeNull();
    for (const setting of ['Duración de la sesión', 'Identity provider (SSO)']) {
      expect(screen.getByText(`Proponer cambio de ${setting}`)).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Proponer cambio' })).toBeNull();
    expect(screen.queryByText('Cambios propuestos')).toBeNull();
  });

  it('sends an MFA reset to Personas: the form by email is gone', async () => {
    renderPage({}, true, null);
    await openAuth();
    expect(await screen.findByText('Restablecer MFA de una persona')).toBeInTheDocument();
    expect(screen.getByText('Solo admins · lo aprueba otro admin')).toBeInTheDocument();
    expect(
      screen.getByText('Se pide sobre la persona, en Ajustes › Personas.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Proponer restablecimiento' })).toBeNull();
    expect(screen.queryByLabelText('Correo del usuario')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ir a Personas →' }));
    expect(screen.getByRole('tab', { name: 'Personas' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('button', { name: /Invitar persona/ })).toBeInTheDocument();
  });
});

describe('General › Autenticación in the lab', () => {
  it('shows MFA as proposable (not fixed) and the configured IdP', async () => {
    renderPage({}, true, null, {
      auth: { installationType: 'lab', mfa: 'off', sessionHours: 8 },
      ssoProvider: 'EntraID',
    });
    await openAuth();
    expect(await screen.findByText('Desactivado')).toBeInTheDocument();
    expect(screen.queryByText('Fijo')).toBeNull();
    expect(screen.queryByText('Siempre obligatorio · viene de la instalación')).toBeNull();
    expect(screen.getByText('Proponer cambio de MFA (app autenticadora)')).toBeInTheDocument();
    expect(screen.getByText('8 h')).toBeInTheDocument();
    expect(screen.getByText('EntraID')).toBeInTheDocument();
  });
});

describe('Connectivity tab', () => {
  it('runs the check and explains what to review on a failure', async () => {
    const user = userEvent.setup();
    const runConnectivityCheck = vi.fn(() =>
      Promise.resolve({
        checked_at: '2026-09-30T10:00:00Z',
        checks: [
          { name: 'broker' as const, status: 'ok' as const, detail: 'AssumeRole ok' },
          {
            name: 'billing_reader' as const,
            status: 'error' as const,
            detail: '<b>AccessDenied</b>',
          },
          { name: 'organizations' as const, status: 'ok' as const, detail: '9 OUs' },
        ],
      }),
    );
    renderPage({ runConnectivityCheck });
    await user.click(await screen.findByRole('tab', { name: 'Conectividad' }));
    expect(screen.getByText('Aún no has probado la conexión')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Probar conexión/ }));
    expect(await screen.findByText('1 de 3 chequeos con error')).toBeInTheDocument();
    expect(screen.getByText('<b>AccessDenied</b>')).toBeInTheDocument();
    expect(screen.getAllByText('Qué revisar:')).toHaveLength(1);
  });

  it('says the check could not run, with the design text, and keeps the last result', async () => {
    const user = userEvent.setup();
    const runConnectivityCheck = vi
      .fn<ApiClient['runConnectivityCheck']>()
      .mockResolvedValueOnce({
        checked_at: '2026-09-30T10:00:00Z',
        checks: [
          { name: 'broker', status: 'ok', detail: 'AssumeRole ok' },
          { name: 'billing_reader', status: 'ok', detail: 'AssumeRole ok' },
          { name: 'organizations', status: 'ok', detail: '9 OUs' },
        ],
      })
      .mockRejectedValueOnce(new ApiError(503, 'unavailable', 'x'));
    renderPage({ runConnectivityCheck });
    await user.click(await screen.findByRole('tab', { name: 'Conectividad' }));
    await user.click(screen.getByRole('button', { name: /Probar conexión/ }));
    expect(await screen.findByText('Todo en orden')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Probar conexión/ }));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('No se pudo ejecutar la prueba');
    expect(banner).toHaveTextContent(
      'El servicio no respondió; no sabemos el estado actual de la conexión. Vuelve a intentarlo en unos segundos.',
    );
    // Not the generic API error message.
    expect(banner).not.toHaveTextContent('no se aplicó ningún cambio');
    expect(screen.getByText('Todo en orden')).toBeInTheDocument();
    expect(screen.getByText('9 OUs')).toBeInTheDocument();
  });

  const allOk = () =>
    Promise.resolve({
      checked_at: '2026-09-30T10:00:00Z',
      checks: [
        { name: 'broker' as const, status: 'ok' as const, detail: 'ok' },
        { name: 'billing_reader' as const, status: 'ok' as const, detail: 'ok' },
        { name: 'organizations' as const, status: 'ok' as const, detail: 'ok' },
      ],
    });

  async function runCheck(api: Partial<ApiClient>) {
    const user = userEvent.setup();
    renderPage(api);
    await user.click(await screen.findByRole('tab', { name: 'Conectividad' }));
    expect(screen.queryByText('Cuentas miembro')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Probar conexión/ }));
    await screen.findByText(/Todo en orden|chequeos con error/);
    return user;
  }

  it('lists the member accounts with only their read role, and the identity check once', async () => {
    const call = vi.fn(
      memberAccess([
        { account_id: '210987654321', name: '<img src=x onerror=alert(1)>', status: 'ok' },
        { account_id: '410987654321', name: 'staging', status: 'ok' },
        { account_id: '510987654321', name: 'sandbox', status: 'role_missing' },
      ]),
    );
    await runCheck({ runConnectivityCheck: vi.fn(allOk), call: call as ApiClient['call'] });
    expect(call).toHaveBeenCalledWith('memberAccessCheck', { body: {} });
    const section = screen.getByRole('group', { name: 'Cuentas miembro' });
    expect(within(section).getByText('1 de 3 cuentas con problemas')).toBeInTheDocument();
    // The account name comes from AWS Organizations: it is text, never markup.
    expect(within(section).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(section.querySelector('img')).toBeNull();
    expect(within(section).getByText('410987654321')).toHaveClass('mono');
    // One row for the identity of the user: it is checked on the broker, not on each account.
    expect(within(section).getAllByText('Exige la identidad del usuario')).toHaveLength(1);
    expect(
      within(section).getByText(
        'Se comprueba en el rol intermedio de Mango, no en cada cuenta: el resultado vale para todas. Lo exige.',
      ),
    ).toBeInTheDocument();
    expect(within(section).getAllByText('El rol de lectura existe.')).toHaveLength(2);
    expect(
      within(section).getByText('No existe el rol de lectura en esta cuenta.'),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(
        'Despliega el rol de lectura de Mango en esta cuenta con el stack de la organización.',
      ),
    ).toBeInTheDocument();
    expect(within(section).getAllByText('error')).toHaveLength(1);
    expect(within(section).getAllByText('ok')).toHaveLength(3);
    expect(within(section).queryByRole('alert')).toBeNull();
  });

  it('says no member account can be read when the broker does not demand the identity', async () => {
    const call = vi.fn(
      memberAccess(
        [
          { account_id: '210987654321', name: 'prod', status: 'identity_not_required' },
          { account_id: '410987654321', name: 'staging', status: 'identity_not_required' },
        ],
        { identity: false },
      ),
    );
    await runCheck({ runConnectivityCheck: vi.fn(allOk), call: call as ApiClient['call'] });
    const section = screen.getByRole('group', { name: 'Cuentas miembro' });
    expect(
      within(section).getByText('Mango no puede leer ninguna cuenta miembro'),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(
        'Se comprueba en el rol intermedio de Mango, no en cada cuenta: el resultado vale para todas. No lo exige.',
      ),
    ).toHaveClass('bad');
    expect(
      within(section).getByText(
        'La política del rol intermedio debe pasar la identidad del usuario al asumir el rol de lectura; sin eso, Mango no lee ninguna cuenta miembro.',
      ),
    ).toBeInTheDocument();
    // Each account only says whether its read role exists.
    expect(within(section).getAllByText('El rol de lectura existe.')).toHaveLength(2);
    expect(within(section).getAllByText('error')).toHaveLength(1);
  });

  it('says how many accounts were checked when there are more than the check covers', async () => {
    const accounts = Array.from({ length: 50 }, (_, index) => ({
      account_id: String(210987654321 + index),
      name: `cuenta-${String(index)}`,
      status: 'ok',
    }));
    const call = vi
      .fn()
      .mockImplementationOnce(memberAccess(accounts, { total: 63 }))
      .mockImplementationOnce(memberAccess(accounts, { total: 51 }))
      .mockImplementationOnce(memberAccess(accounts));
    const user = await runCheck({
      runConnectivityCheck: vi.fn(allOk),
      call: call as ApiClient['call'],
    });
    const section = () => screen.getByRole('group', { name: 'Cuentas miembro' });
    const notice = within(section()).getByRole('alert');
    expect(notice).toHaveTextContent('Se comprobaron 50 de 63 cuentas');
    expect(notice).toHaveTextContent(
      'La prueba revisa como máximo 50 cuentas. Las otras 13 no se comprobaron.',
    );
    expect(within(section()).getByText('50 cuentas en orden')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Probar conexión/ }));
    expect(await screen.findByText('Se comprobaron 50 de 51 cuentas')).toBeInTheDocument();
    expect(within(section()).getByRole('alert')).toHaveTextContent('La otra no se comprobó.');
    await user.click(screen.getByRole('button', { name: /Probar conexión/ }));
    await waitFor(() => {
      expect(within(section()).queryByRole('alert')).toBeNull();
    });
  });

  it('says how many member accounts are in order, and shows nothing without accounts', async () => {
    const ok = (id: string) => ({ account_id: id, name: `cuenta-${id}`, status: 'ok' });
    const call = vi
      .fn()
      .mockImplementationOnce(memberAccess([ok('210987654321')]))
      .mockImplementationOnce(memberAccess([ok('210987654321'), ok('310987654321')]))
      .mockImplementationOnce(memberAccess([]));
    const user = await runCheck({
      runConnectivityCheck: vi.fn(allOk),
      call: call as ApiClient['call'],
    });
    expect(await screen.findByText('1 cuenta en orden')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Probar conexión/ }));
    expect(await screen.findByText('2 cuentas en orden')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Probar conexión/ }));
    await waitFor(() => {
      expect(screen.queryByText('Cuentas miembro')).toBeNull();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the check could not run when the member accounts cannot be checked', async () => {
    const call = vi.fn(memberAccess(new ApiError(502, 'upstream_error', 'arn:aws:iam::1:role/x')));
    await runCheck({ runConnectivityCheck: vi.fn(allOk), call: call as ApiClient['call'] });
    // Its own banner, under its heading: the connection above is in order.
    const section = screen.getByRole('group', { name: 'Cuentas miembro' });
    const alert = within(section).getByRole('alert');
    expect(alert).toHaveTextContent('No se pudieron comprobar las cuentas miembro');
    expect(alert).toHaveTextContent(
      'La conexión principal está bien, pero la comprobación de las cuentas miembro no respondió. Vuelve a intentarlo en unos segundos.',
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByText('No se pudo ejecutar la prueba')).toBeNull();
    expect(screen.getByText('Todo en orden')).toBeInTheDocument();
    expect(within(section).queryByText('Exige la identidad del usuario')).toBeNull();
    expect(screen.queryByText(/arn:aws/)).toBeNull();
  });

  it('replaces the banner of the member accounts with the next result', async () => {
    const call = vi
      .fn()
      .mockImplementationOnce(memberAccess(new ApiError(502, 'upstream_error', 'x')))
      .mockImplementationOnce(
        memberAccess([{ account_id: '210987654321', name: 'prod', status: 'ok' }]),
      );
    const user = await runCheck({
      runConnectivityCheck: vi.fn(allOk),
      call: call as ApiClient['call'],
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No se pudieron comprobar las cuentas miembro',
    );
    await user.click(screen.getByRole('button', { name: /Probar conexión/ }));
    expect(await screen.findByText('1 cuenta en orden')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('leaves the failed check as the explanation when the accounts could not be read', async () => {
    const runConnectivityCheck = vi.fn(() =>
      Promise.resolve({
        checked_at: '2026-09-30T10:00:00Z',
        checks: [
          { name: 'broker' as const, status: 'ok' as const, detail: 'ok' },
          { name: 'billing_reader' as const, status: 'error' as const, detail: 'access denied' },
          { name: 'organizations' as const, status: 'error' as const, detail: 'skipped' },
        ],
      }),
    );
    const call = vi.fn(memberAccess(new ApiError(502, 'upstream_error', 'x')));
    await runCheck({ runConnectivityCheck, call: call as ApiClient['call'] });
    expect(screen.getByText('2 de 3 chequeos con error')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Cuentas miembro')).toBeNull();
  });

  it('counts down after the API rate limit (429)', async () => {
    const user = userEvent.setup();
    renderPage({
      runConnectivityCheck: vi.fn(() => Promise.reject(new ApiError(429, 'rate_limited', 'x'))),
    });
    await user.click(await screen.findByRole('tab', { name: 'Conectividad' }));
    await user.click(screen.getByRole('button', { name: /Probar conexión/ }));
    expect(await screen.findByRole('button', { name: 'Disponible en 60 s' })).toBeDisabled();
    expect(screen.getByText('Demasiadas pruebas')).toBeInTheDocument();
  });

  it('counts down the Retry-After the API sent with the 429', async () => {
    const user = userEvent.setup();
    renderPage({
      runConnectivityCheck: vi.fn(() => Promise.reject(new ApiError(429, 'rate_limited', 'x', 17))),
    });
    await user.click(await screen.findByRole('tab', { name: 'Conectividad' }));
    await user.click(screen.getByRole('button', { name: /Probar conexión/ }));
    expect(await screen.findByRole('button', { name: 'Disponible en 17 s' })).toBeDisabled();
  });
});
