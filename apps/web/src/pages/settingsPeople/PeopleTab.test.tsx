import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { MfaReset } from '../../api/mfaResetSchemas';
import { businessUnitsFixture } from '../../test/adminFixtures';
import { baseMe, sessionValue, testConfig } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import type { MemberChange, People, Person } from './model';
import { PeopleTab } from './PeopleTab';

const ME = {
  ...baseMe,
  user_id: 'a1b2c3d4-0000-4000-8000-0000000000aa',
  email: 'admin1@example.com',
  is_admin: true,
  groups: ['mango-admin'],
};
const FUTURE = '2999-01-01T00:00:00Z';

let serial = 0;
function person(overrides: Partial<Person> = {}): Person {
  serial += 1;
  return {
    user_id: `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
    email: `usuario${String(serial)}@example.com`,
    status: 'active',
    mfa: true,
    groups: ['people'],
    created_at: '2026-01-15T12:00:00+00:00',
    ...overrides,
  };
}

function directory(items: Person[], overrides: Partial<People> = {}): People {
  return {
    items,
    next_cursor: null,
    pending: 0,
    admins: 3,
    with_access: 4,
    incomplete: false,
    ...overrides,
  };
}

function change(overrides: Partial<MemberChange> = {}): MemberChange {
  return {
    change_id: 'c'.repeat(32),
    kind: 'add',
    group: 'mango-admin',
    status: 'pending',
    target_user: 'target-1',
    target_email: 'usuario2@example.com',
    proposed_by: 'admin-2',
    proposed_by_email: 'admin2@example.com',
    reason: 'Cubre las aprobaciones',
    created_at: new Date().toISOString(),
    expires_at: FUTURE,
    decided_by: null,
    decided_by_email: null,
    decided_at: null,
    note: null,
    ...overrides,
  };
}

function reset(overrides: Partial<MfaReset> = {}): MfaReset {
  return {
    change_id: 'd'.repeat(32),
    status: 'pending',
    target_user: 'target-sub',
    target_email: 'usuario3@example.com',
    proposed_by: 'admin-2',
    proposed_by_email: 'admin2@example.com',
    reason: 'Cambió de teléfono',
    identity_verified: true,
    created_at: new Date().toISOString(),
    expires_at: FUTURE,
    decided_by: null,
    decided_by_email: null,
    decided_at: null,
    note: null,
    ...overrides,
  };
}

const GROUPS = {
  items: [
    { id: 'bu-finanzas', type: 'area', area: 'finanzas', description: 'Líderes de Finanzas' },
    { id: 'finops-central', type: 'central', area: null, description: 'FinOps central' },
    { id: 'people', type: 'general', area: null, description: '<b>Personas</b> y Cultura' },
  ].map((group) => ({ ...group, version: 0, system: false, fixed_type: false, agents: [] })),
  changes: [],
};

type Input = { path?: Record<string, string>; body?: Record<string, unknown> };
type Handler = (input: Input) => unknown;
type Answer = object | Handler;
const isHandler = (answer: Answer): answer is Handler => typeof answer === 'function';

/** `api.call` by operation; an `Error` (or a function that throws) rejects. */
function apiWith(answers: Record<string, Answer>) {
  const all: Record<string, Answer> = {
    searchPeople: directory([]),
    getMemberChanges: { items: [] },
    getAdminGroups: GROUPS,
    ...answers,
  };
  return vi.fn((operation: string, input: Input = {}) => {
    const answer = all[operation];
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${operation}`));
    try {
      const value: unknown = isHandler(answer) ? answer(input) : answer;
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('failed'));
    }
  });
}

function renderTab(
  call: ReturnType<typeof apiWith>,
  api: Partial<ApiClient> = {},
  { units = businessUnitsFixture(), domains = ['example.com', 'example.org'] } = {},
) {
  const notify = vi.fn();
  const onForbidden = vi.fn();
  const onGoTab = vi.fn();
  const fake = {
    call,
    getBusinessUnits: vi.fn(() => Promise.resolve(units)),
    listMfaResets: vi.fn(() => Promise.resolve([] as MfaReset[])),
    proposeMfaReset: vi.fn(() => Promise.resolve({ change_id: 'e'.repeat(32) })),
    ...api,
  };
  const view = render(
    <TestProviders
      session={sessionValue({
        api: fake as unknown as ApiClient,
        me: ME,
        config: { ...testConfig, signUpDomains: domains },
      })}
    >
      <PeopleTab notify={notify} onForbidden={onForbidden} onGoTab={onGoTab} />
    </TestProviders>,
  );
  return { ...view, call, fake, notify, onForbidden, onGoTab, user: userEvent.setup() };
}

const calls = (call: ReturnType<typeof apiWith>, operation: string) =>
  call.mock.calls.filter(([name]) => name === operation).map(([, input]) => input);

async function openPanel(user: ReturnType<typeof userEvent.setup>, email: string) {
  await user.click(await screen.findByRole('button', { name: `Gestionar ${email}` }));
  return screen.getByRole('dialog', { name: `Persona ${email}` });
}

describe('Ajustes › Personas (design people.jsx)', () => {
  it('lists the directory with chip, status, MFA, groups and date, as text', async () => {
    const people = [
      person({ email: 'nueva@example.com', groups: [] }),
      person({ email: ME.email, groups: ['bu-lead', 'finops-central', 'mango-admin'] }),
      person({ email: 'invitada@example.com', status: 'invited', mfa: false }),
      person({ email: '<img src=x onerror=alert(1)>@example.com', status: 'disabled' }),
    ];
    const { container } = renderTab(apiWith({ searchPeople: directory(people, { pending: 1 }) }));
    const list = await screen.findByRole('list', { name: 'Personas del directorio' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('nueva@example.com');
    expect(within(rows[0] as HTMLElement).getByText('Sin acceso')).toHaveAttribute(
      'title',
      'Se registró y aún no tiene ningún grupo',
    );
    expect(rows[0]).toHaveTextContent('Sin grupos');
    expect(rows[0]).toHaveTextContent('15 ene 2026');
    // The session's own account, and only two groups before «+N».
    expect(rows[1]).toHaveTextContent('tú');
    expect(rows[1]).toHaveTextContent('bu-lead');
    expect(rows[1]).toHaveTextContent('finops-central');
    expect(rows[1]).toHaveTextContent('+1');
    expect(rows[1]).toHaveTextContent('Registrado');
    expect(rows[2]).toHaveTextContent('Invitada · contraseña temporal');
    expect(rows[2]).toHaveTextContent('Sin registrar');
    expect(rows[3]).toHaveTextContent('Deshabilitada');
    expect(rows[3]).toHaveTextContent('<img src=x onerror=alert(1)>@example.com');
    expect(container.querySelector('img')).toBeNull();
    // The people without access: a notice and a counter on its filter.
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 persona se registró y aún no tiene acceso a nada. Al entrar ven «Todavía no tienes acceso» hasta que les asignes un grupo.',
    );
    expect(screen.getByRole('button', { name: /^Sin acceso\s*1$/ })).toBeInTheDocument();
  });

  it('searches by the start of the email in the body of the request, once the typing stops', async () => {
    const call = apiWith({ searchPeople: directory([person()]) });
    const { user } = renderTab(call);
    await screen.findByRole('list', { name: 'Personas del directorio' });
    expect(calls(call, 'searchPeople')).toEqual([{ body: { prefix: null, filter: 'all' } }]);

    await user.type(screen.getByRole('searchbox', { name: 'Buscar por correo' }), ' Usu');
    await waitFor(() => {
      expect(calls(call, 'searchPeople')).toHaveLength(2);
    });
    // One request for the whole word, normalized; the prefix is never a path or a query.
    expect(calls(call, 'searchPeople')[1]).toEqual({ body: { prefix: 'usu', filter: 'all' } });

    await user.click(screen.getByRole('button', { name: 'Deshabilitadas' }));
    await waitFor(() => {
      expect(calls(call, 'searchPeople')[2]).toEqual({
        body: { prefix: 'usu', filter: 'disabled' },
      });
    });
    expect(screen.getByRole('button', { name: 'Deshabilitadas' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('says why a list is empty, and asks nothing for a prefix no email can start with', async () => {
    const call = apiWith({ searchPeople: directory([]) });
    const { user } = renderTab(call);
    expect(await screen.findByText('No hay personas en este estado.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sin acceso' }));
    expect(await screen.findByText('Nadie está esperando acceso.')).toBeInTheDocument();
    const before = calls(call, 'searchPeople').length;
    await user.type(screen.getByRole('searchbox', { name: 'Buscar por correo' }), 'a"b');
    expect(await screen.findByText('Ningún correo empieza por «a"b».')).toBeInTheDocument();
    expect(calls(call, 'searchPeople')).toHaveLength(before);
  });

  it('adds the next page with the cursor of the API', async () => {
    const first = person();
    const second = person();
    const call = apiWith({
      searchPeople: ({ body }: Input) =>
        body?.cursor === '20'
          ? directory([second])
          : directory([first], { next_cursor: '20', incomplete: true }),
    });
    const { user } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: 'Mostrar más' }));
    expect(await screen.findByTitle(second.email)).toBeInTheDocument();
    expect(screen.getByTitle(first.email)).toBeInTheDocument();
    expect(calls(call, 'searchPeople')[1]).toEqual({
      body: { prefix: null, filter: 'all', cursor: '20' },
    });
    expect(screen.queryByRole('button', { name: 'Mostrar más' })).toBeNull();
    expect(
      screen.getByText(
        'El directorio es más grande de lo que se lee de una vez: los contadores son un mínimo.',
      ),
    ).toBeInTheDocument();
  });

  it('says the directory could not be loaded, without the server message, and retries', async () => {
    let fail = true;
    const call = apiWith({
      searchPeople: () => {
        if (fail) throw new ApiError(502, 'upstream_error', 'arn:aws:cognito-idp:pool/x');
        return directory([person({ email: 'ana@example.com' })]);
      },
    });
    const { user, onForbidden } = renderTab(call);
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar el directorio.');
    expect(screen.queryByText(/arn:aws/)).toBeNull();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByTitle('ana@example.com')).toBeInTheDocument();
    expect(onForbidden).not.toHaveBeenCalled();
  });

  it('hands a 403 to the page', async () => {
    const { onForbidden } = renderTab(
      apiWith({ searchPeople: new ApiError(403, 'forbidden', 'x') }),
    );
    await waitFor(() => {
      expect(onForbidden).toHaveBeenCalled();
    });
  });
});

describe('Panel of a person', () => {
  it('adds a normal group at once and says what the API answered', async () => {
    const ana = person({ email: 'ana@example.com', groups: ['people'] });
    let groups = ana.groups;
    const call = apiWith({
      searchPeople: () => directory([{ ...ana, groups }]),
      addGroup: ({ body }: Input) => {
        groups = [...groups, String(body?.group)];
        return { result: 'applied', change_id: null };
      },
    });
    const { user, notify, container } = renderTab(call);
    const panel = await openPanel(user, ana.email);
    expect(within(panel).getByText('MFA registrado')).toBeInTheDocument();
    // The group she has, with its type; its description is text.
    expect(within(panel).getByText('General')).toBeInTheDocument();
    const select = within(panel).getByRole('combobox', { name: 'Agregar a un grupo' });
    // System groups first, in the design's order; the sensitive ones say so.
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Elige un grupo',
      'mango-admin · con aprobación',
      'mango-agent-creator',
      'finops-central · con aprobación',
      'bu-lead',
      'bu-finanzas · área finanzas',
    ]);
    await user.selectOptions(select, 'bu-finanzas');
    expect(within(panel).getByText('Líderes de Finanzas')).toBeInTheDocument();
    expect(within(panel).queryByLabelText('Motivo')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Agregar' }));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Grupo agregado');
    });
    expect(calls(call, 'addGroup')).toEqual([
      { path: { user_id: ana.user_id }, body: { group: 'bu-finanzas', reason: undefined } },
    ]);
    // Shown at once, and the directory is read again.
    expect(within(panel).getByText('bu-finanzas')).toBeInTheDocument();
    expect(calls(call, 'searchPeople').length).toBeGreaterThan(1);
    expect(container.querySelector('b')).toBeNull();
  });

  it('asks for a reason to give a sensitive group, and it stays pending', async () => {
    const ana = person({ email: 'ana@example.com' });
    const call = apiWith({
      searchPeople: directory([ana]),
      addGroup: { result: 'proposed', change_id: 'f'.repeat(32) },
    });
    const { user, notify } = renderTab(call);
    const panel = await openPanel(user, ana.email);
    await user.selectOptions(within(panel).getByRole('combobox'), 'mango-admin');
    expect(
      within(panel).getByText(
        'Administradores de Mango · administra Mango y aprueba cambios de otros.',
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        'No se aplica hasta que otro administrador lo apruebe. Si nadie lo decide en 72 h, vence.',
      ),
    ).toBeInTheDocument();
    const send = within(panel).getByRole('button', { name: 'Enviar a aprobación' });
    await user.click(send);
    expect(within(panel).getByRole('alert')).toHaveTextContent('Escribe el motivo');
    expect(calls(call, 'addGroup')).toHaveLength(0);
    await user.type(within(panel).getByLabelText('Motivo'), 'Cubre las aprobaciones');
    await user.click(send);
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Propuesta enviada · la debe aprobar otro admin');
    });
    expect(calls(call, 'addGroup')[0]).toEqual({
      path: { user_id: ana.user_id },
      body: { group: 'mango-admin', reason: 'Cubre las aprobaciones' },
    });
    // Nothing was applied: she does not have the group.
    expect(within(panel).queryByText('Central')).toBeNull();
  });

  it('follows the answer of the API, not its own labels: a normal group may be proposed', async () => {
    const ana = person({ email: 'ana@example.com' });
    const call = apiWith({
      searchPeople: directory([ana]),
      addGroup: { result: 'proposed', change_id: 'f'.repeat(32) },
    });
    const { user, notify } = renderTab(call);
    const panel = await openPanel(user, ana.email);
    await user.selectOptions(within(panel).getByRole('combobox'), 'bu-lead');
    await user.click(within(panel).getByRole('button', { name: 'Agregar' }));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Propuesta enviada · la debe aprobar otro admin');
    });
    expect(notify).not.toHaveBeenCalledWith('Grupo agregado');
  });

  it('labels the bootstrap while there is a single administrator', async () => {
    const ana = person({ email: 'ana@example.com' });
    const call = apiWith({
      searchPeople: directory([ana], { admins: 1 }),
      addGroup: { result: 'bootstrap', change_id: null },
    });
    const { user, notify } = renderTab(call);
    const panel = await openPanel(user, ana.email);
    await user.selectOptions(within(panel).getByRole('combobox'), 'mango-admin');
    expect(
      within(panel).getByText(
        'Eres el único administrador: este cambio se aplica sin segundo aprobador y queda marcado en Auditoría. Desde entonces, dar o quitar administradores lo aprueba el otro.',
      ),
    ).toBeInTheDocument();
    expect(within(panel).queryByLabelText('Motivo')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Agregar' }));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Grupo agregado');
    });
  });

  it('lets the own account ask for a sensitive group, but not drop one or disable itself', async () => {
    const own = person({ email: ME.email, groups: ['mango-admin', 'people'] });
    const call = apiWith({
      searchPeople: directory([own]),
      addGroup: { result: 'proposed', change_id: 'f'.repeat(32) },
    });
    const { user, notify } = renderTab(call);
    const panel = await openPanel(user, own.email);
    expect(within(panel).getByText('Tu cuenta')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Quitar mango-admin' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Quitar people' })).toBeEnabled();
    // A sensitive group for the own account is asked for like any other: another one approves.
    await user.selectOptions(within(panel).getByRole('combobox'), 'finops-central');
    await user.type(within(panel).getByLabelText('Motivo'), 'Reviso los costos');
    await user.click(within(panel).getByRole('button', { name: 'Enviar a aprobación' }));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Propuesta enviada · la debe aprobar otro admin');
    });
    expect(
      within(panel).getByText('Es tu cuenta: otro administrador debe restablecer tu MFA.'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('No puedes deshabilitar tu propia cuenta.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Deshabilitar acceso/ })).toBeNull();
  });

  it('removes a normal group at once and a sensitive one with a reason', async () => {
    const ana = person({ email: 'ana@example.com', groups: ['finops-central', 'people'] });
    let groups = ana.groups;
    const call = apiWith({
      searchPeople: () => directory([{ ...ana, groups }]),
      removeGroup: ({ body }: Input) => {
        if (body?.group !== 'people') return { result: 'proposed', change_id: null };
        groups = groups.filter((group) => group !== 'people');
        return { result: 'applied', change_id: null };
      },
    });
    const { user, notify } = renderTab(call);
    const panel = await openPanel(user, ana.email);
    await user.click(within(panel).getByRole('button', { name: 'Quitar people' }));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Grupo quitado');
    });
    expect(within(panel).queryByRole('button', { name: 'Quitar people' })).toBeNull();

    await user.click(within(panel).getByRole('button', { name: 'Quitar finops-central' }));
    const send = within(panel).getByRole('button', { name: 'Enviar a aprobación' });
    expect(send).toBeDisabled();
    await user.type(within(panel).getByLabelText('Motivo para quitar el grupo'), 'Cambió de área');
    await user.click(send);
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Propuesta enviada · la debe aprobar otro admin');
    });
    expect(calls(call, 'removeGroup')[1]).toEqual({
      path: { user_id: ana.user_id },
      body: { group: 'finops-central', reason: 'Cambió de área' },
    });
    expect(within(panel).getByRole('button', { name: 'Quitar finops-central' })).toBeEnabled();
  });

  it('does not offer to leave a single administrator, and shows what is waiting', async () => {
    const boss = person({ email: 'jefa@example.com', groups: ['mango-admin', 'people'] });
    const call = apiWith({
      searchPeople: directory([boss], { admins: 2 }),
      getMemberChanges: {
        items: [
          change({ kind: 'remove', group: 'people', target_user: boss.user_id }),
          change({
            change_id: '1'.repeat(32),
            kind: 'add',
            group: 'finops-central',
            target_user: boss.user_id,
          }),
        ],
      },
    });
    const { user } = renderTab(call);
    expect(await screen.findByText('2 cambios pendientes')).toBeInTheDocument();
    const panel = await openPanel(user, boss.email);
    expect(within(panel).getByRole('button', { name: 'Quitar mango-admin' })).toBeDisabled();
    expect(
      within(panel).getByText(
        'Quedaría un solo administrador y nadie podría aprobar las acciones con doble aprobación.',
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Deshabilitar acceso…' })).toBeDisabled();
    expect(within(panel).getByText('Quitar · pendiente de aprobación')).toBeInTheDocument();
    expect(within(panel).getByText('Agregar · pendiente de aprobación')).toBeInTheDocument();
    // A group that is being asked for is not offered again.
    expect(
      within(panel).queryByRole('option', { name: 'finops-central · con aprobación' }),
    ).toBeNull();
  });

  it('disables with a reason, and shows the refusal of the API with a text of the app', async () => {
    const ana = person({ email: 'ana@example.com' });
    let refuse = true;
    let status = ana.status;
    const call = apiWith({
      searchPeople: () => directory([{ ...ana, status }]),
      disablePerson: () => {
        if (refuse) throw new ApiError(409, 'last_admins', 'name another administrator first');
        status = 'disabled';
        return { result: 'applied', change_id: null };
      },
    });
    const { user, notify } = renderTab(call);
    const panel = await openPanel(user, ana.email);
    await user.click(within(panel).getByRole('button', { name: 'Deshabilitar acceso…' }));
    const submit = within(panel).getByRole('button', { name: 'Deshabilitar acceso' });
    expect(submit).toBeDisabled();
    await user.type(
      within(panel).getByLabelText('Motivo para deshabilitar'),
      'Salió de la empresa',
    );
    await user.click(submit);
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Nombra otro administrador antes de quitar o deshabilitar a este.',
    );
    expect(within(panel).queryByText(/name another/)).toBeNull();
    refuse = false;
    await user.click(submit);
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Acceso deshabilitado');
    });
    expect(calls(call, 'disablePerson')[1]).toEqual({
      path: { user_id: ana.user_id },
      body: { reason: 'Salió de la empresa' },
    });
    expect(
      within(panel).getByText('Acceso deshabilitado: rehabilítalo para cambiar sus grupos.'),
    ).toBeInTheDocument();
  });

  it.each([
    [
      new ApiError(502, 'upstream_error', 'the directory could not be changed'),
      'No se pudo completar la acción. Inténtalo de nuevo.',
    ],
    // An administrator who stopped being one, and another change in progress.
    [
      new ApiError(403, 'forbidden', 'not allowed'),
      'Ya no tienes permiso de administrador: tus acciones en Personas se rechazan. Vuelve a entrar para actualizar tu sesión.',
    ],
    [
      new ApiError(409, 'version_conflict', 'another change is in progress'),
      'Otro cambio de administradores está en curso. Inténtalo de nuevo en unos segundos.',
    ],
  ])(
    'shows a refusal with a text of the design, never the server message (%s)',
    async (failure, text) => {
      const ana = person({ email: 'ana@example.com' });
      const call = apiWith({
        searchPeople: directory([ana]),
        removeGroup: () => {
          throw failure;
        },
      });
      const { user } = renderTab(call);
      const panel = await openPanel(user, ana.email);
      await user.click(within(panel).getByRole('button', { name: 'Quitar people' }));
      expect(await within(panel).findByRole('alert')).toHaveTextContent(text);
      expect(within(panel).queryByText(failure.message)).toBeNull();
    },
  );

  it('re-enables at once, or with a reason when the person holds a sensitive group', async () => {
    const plain = person({ email: 'ana@example.com', status: 'disabled' });
    const central = person({
      email: 'luis@example.com',
      status: 'disabled',
      groups: ['finops-central'],
    });
    const call = apiWith({
      searchPeople: directory([plain, central]),
      enablePerson: ({ body }: Input) => ({
        result: body?.reason ? 'proposed' : 'applied',
        change_id: null,
      }),
    });
    const { user, notify } = renderTab(call);
    let panel = await openPanel(user, plain.email);
    await user.click(within(panel).getByRole('button', { name: 'Rehabilitar acceso' }));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Acceso rehabilitado');
    });
    await user.click(within(panel).getByRole('button', { name: 'Cerrar' }));

    panel = await openPanel(user, central.email);
    expect(
      within(panel).getByText(
        'No puede entrar. Tiene un grupo sensible: rehabilitarla lo aprueba otro administrador.',
      ),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Rehabilitar acceso' })).toBeNull();
    // Same pattern as the other forms of the panel: a button opens it and «Cancelar» closes it.
    expect(within(panel).queryByLabelText('Motivo para rehabilitar')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Rehabilitar acceso…' }));
    await user.type(within(panel).getByLabelText('Motivo para rehabilitar'), 'x');
    await user.click(within(panel).getByRole('button', { name: 'Cancelar' }));
    expect(within(panel).queryByLabelText('Motivo para rehabilitar')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Rehabilitar acceso…' }));
    expect(within(panel).getByLabelText('Motivo para rehabilitar')).toHaveValue('');
    const send = within(panel).getByRole('button', { name: 'Enviar a aprobación' });
    expect(send).toBeDisabled();
    await user.type(within(panel).getByLabelText('Motivo para rehabilitar'), 'Volvió de licencia');
    await user.click(send);
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Propuesta enviada · la debe aprobar otro admin');
    });
    expect(calls(call, 'enablePerson')).toEqual([
      { path: { user_id: plain.user_id }, body: { reason: undefined } },
      { path: { user_id: central.user_id }, body: { reason: 'Volvió de licencia' } },
    ]);
    // Still disabled: another administrator decides. The form closes.
    await waitFor(() => {
      expect(within(panel).queryByLabelText('Motivo para rehabilitar')).toBeNull();
    });
  });

  it('asks for an MFA reset with a reason and the identity check', async () => {
    const ana = person({ email: 'ana@example.com' });
    const call = apiWith({ searchPeople: directory([ana]) });
    const { user, notify, fake } = renderTab(call);
    const panel = await openPanel(user, ana.email);
    await user.click(within(panel).getByRole('button', { name: 'Restablecer MFA…' }));
    const submit = within(panel).getByRole('button', { name: 'Proponer restablecimiento' });
    await user.click(submit);
    expect(within(panel).getByRole('alert')).toHaveTextContent('Escribe el motivo');
    await user.type(
      within(panel).getByLabelText('Motivo del restablecimiento'),
      'Perdió el teléfono',
    );
    await user.click(submit);
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Confirma que verificaste la identidad por otro canal',
    );
    expect(fake.proposeMfaReset).not.toHaveBeenCalled();
    await user.click(within(panel).getByRole('checkbox'));
    await user.click(submit);
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Solicitud enviada · la debe aprobar otro admin');
    });
    expect(fake.proposeMfaReset).toHaveBeenCalledWith(
      'ana@example.com',
      'Perdió el teléfono',
      true,
    );
  });

  it('shows an MFA reset that is waiting, and none to ask for without MFA', async () => {
    const ana = person({ email: 'usuario3@example.com' });
    const invited = person({ email: 'nueva@example.com', status: 'invited', mfa: false });
    const call = apiWith({ searchPeople: directory([ana, invited]) });
    const { user } = renderTab(call, { listMfaResets: vi.fn(() => Promise.resolve([reset()])) });
    expect(await screen.findByText('Cambio pendiente')).toBeInTheDocument();
    let panel = await openPanel(user, ana.email);
    expect(within(panel).getByText('Pendiente de aprobación')).toBeInTheDocument();
    expect(
      within(panel).getByText('Se decide en la lista de restablecimientos.'),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Restablecer MFA…' })).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();

    panel = await openPanel(user, invited.email);
    expect(
      within(panel).getByText(
        'Recibió una contraseña temporal por correo. Al entrar crea la suya y configura MFA.',
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText('Todavía no registró MFA: lo configura en su próximo ingreso.'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        'Desde Mango no se cambia el correo ni la contraseña de otra persona, ni se ven sus conversaciones.',
      ),
    ).toBeInTheDocument();
  });
});

describe('Invitar persona', () => {
  it('validates the email with the texts of the design before asking the API', async () => {
    const call = apiWith({ searchPeople: directory([person()]) });
    const { user } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: /Invitar persona/ }));
    const dialog = screen.getByRole('dialog', { name: 'Invitar persona' });
    expect(
      within(dialog).getByText(
        'Se registran solos: example.com, example.org. A los demás correos de empresa se les invita aquí; los correos públicos no se aceptan.',
      ),
    ).toBeInTheDocument();
    const email = within(dialog).getByLabelText('Correo');
    const submit = within(dialog).getByRole('button', { name: 'Enviar invitación' });
    await user.click(submit);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Escribe el correo');
    await user.type(email, 'sin-arroba');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Escribe un correo válido');
    expect(calls(call, 'invitePerson')).toHaveLength(0);
    // The sensitive groups are asked for afterwards, on the person.
    const groups = within(dialog).getByRole('group', { name: /Grupos/ });
    expect(within(groups).queryByRole('button', { name: 'mango-admin' })).toBeNull();
    expect(within(groups).queryByRole('button', { name: 'finops-central' })).toBeNull();
    expect(within(groups).getByRole('button', { name: 'bu-finanzas' })).toBeInTheDocument();
  });

  it('invites with the groups picked, and shows what the API refuses', async () => {
    let answer: unknown = new ApiError(
      409,
      'already_exists',
      'that email is already in the directory',
    );
    const call = apiWith({
      searchPeople: directory([person()]),
      invitePerson: () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    const { user, notify } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: /Invitar persona/ }));
    const dialog = screen.getByRole('dialog', { name: 'Invitar persona' });
    await user.type(within(dialog).getByLabelText('Correo'), ' Ana@Example.com ');
    await user.click(within(dialog).getByRole('button', { name: 'bu-finanzas' }));
    const submit = within(dialog).getByRole('button', { name: 'Enviar invitación' });
    await user.click(submit);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Ese correo ya está en el directorio. Ábrelo en la lista para cambiar sus grupos.',
    );
    answer = new ApiError(502, 'upstream_error', 'the invitation could not be sent');
    await user.click(submit);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'No se pudo enviar la invitación. Inténtalo de nuevo.',
    );
    answer = { user_id: 'new-user', result: 'applied' };
    await user.click(submit);
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        'Invitación enviada · recibirá una contraseña temporal por correo',
      );
    });
    expect(calls(call, 'invitePerson').at(-1)).toEqual({
      body: { email: 'ana@example.com', groups: ['bu-finanzas'] },
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks the API whether a domain is a public provider, so the refusal is audited', async () => {
    const call = apiWith({
      searchPeople: directory([person()]),
      invitePerson: () => {
        throw new ApiError(422, 'public_domain', 'that email cannot be invited');
      },
    });
    const { user } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: /Invitar persona/ }));
    const dialog = screen.getByRole('dialog', { name: 'Invitar persona' });
    // The screen keeps no list of providers: a country variant goes to the API like any other.
    await user.type(within(dialog).getByLabelText('Correo'), 'ana@outlook.es');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar invitación' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Los correos públicos no se aceptan. Usa el correo de la empresa.',
    );
    expect(calls(call, 'invitePerson')).toEqual([
      { body: { email: 'ana@outlook.es', groups: [] } },
    ]);
    // It is the answer to the submit, not a check of the field.
    expect(within(dialog).getByLabelText('Correo')).not.toHaveAttribute('aria-invalid');
  });

  it('sends an address of another company to the API', async () => {
    const call = apiWith({
      searchPeople: directory([person()]),
      invitePerson: { user_id: 'new-user', result: 'applied' },
    });
    const { user } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: /Invitar persona/ }));
    const dialog = screen.getByRole('dialog', { name: 'Invitar persona' });
    await user.type(within(dialog).getByLabelText('Correo'), 'ana@otra.com');
    expect(
      within(dialog).getByText(
        'Dominio externo: se invita como persona de otra empresa y queda así en Auditoría.',
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Enviar invitación' }));
    await waitFor(() => {
      expect(calls(call, 'invitePerson')).toEqual([
        { body: { email: 'ana@otra.com', groups: [] } },
      ]);
    });
  });
});

describe('Primeros pasos de esta instalación', () => {
  it('shows the steps that are missing and invites the second administrator', async () => {
    const units = { ...businessUnitsFixture(), units: {} };
    const call = apiWith({
      searchPeople: directory([person({ groups: [] })], { admins: 1, with_access: 0, pending: 1 }),
      getAdminGroups: { items: [GROUPS.items[1]], changes: [] },
    });
    const { user, onGoTab } = renderTab(call, {}, { units });
    const title = await screen.findByRole('heading', {
      name: 'Primeros pasos de esta instalación',
    });
    const card = title.closest('.pp-first') as HTMLElement;
    expect(
      within(card).getByText(
        'Faltan 4 pasos para que tu equipo empiece a usar Mango. Esta tarjeta desaparece cuando estén todos.',
      ),
    ).toBeInTheDocument();
    expect(within(card).getByText('Solo tú')).toBeInTheDocument();
    expect(within(card).getByText('Sin áreas')).toBeInTheDocument();
    expect(within(card).getByText('Solo los de sistema')).toBeInTheDocument();
    expect(within(card).getByText('1 esperando acceso')).toBeInTheDocument();
    expect(within(card).getAllByText('Necesita un segundo administrador')).toHaveLength(2);
    expect(within(card).getByRole('link', { name: 'Presupuestos' })).toHaveAttribute(
      'href',
      '/budgets',
    );
    expect(card).toHaveTextContent('MFA obligatorio y registro solo con example.com, example.org.');
    await user.click(within(card).getByRole('button', { name: 'Ir a Grupos' }));
    expect(onGoTab).toHaveBeenCalledWith('groups');

    await user.click(within(card).getByRole('button', { name: 'Invitar administrador' }));
    const dialog = screen.getByRole('dialog', { name: 'Invitar al segundo administrador' });
    // Bootstrap: `mango-admin` comes chosen and can be given with the invitation.
    expect(within(dialog).getByRole('button', { name: 'mango-admin' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      within(dialog).getByText(
        'Eres el único administrador: mango-admin se aplica sin segundo aprobador y queda marcado en Auditoría.',
      ),
    ).toBeInTheDocument();
  });

  it('counts what is done, and goes away once every step is', async () => {
    const half = apiWith({ searchPeople: directory([person()], { admins: 2, with_access: 0 }) });
    const { unmount } = renderTab(half);
    const title = await screen.findByRole('heading', {
      name: 'Primeros pasos de esta instalación',
    });
    const card = title.closest('.pp-first') as HTMLElement;
    expect(
      await within(card).findByText(
        'Falta 1 paso para que tu equipo empiece a usar Mango. Esta tarjeta desaparece cuando estén todos.',
      ),
    ).toBeInTheDocument();
    expect(within(card).getByText('Hecho · 2 administradores')).toBeInTheDocument();
    expect(within(card).getByText('Hecho · 2 grupos propios')).toBeInTheDocument();
    expect(within(card).getByText('Nadie más tiene acceso')).toBeInTheDocument();
    unmount();

    renderTab(apiWith({ searchPeople: directory([person()]) }));
    await screen.findByRole('list', { name: 'Personas del directorio' });
    expect(screen.queryByText('Primeros pasos de esta instalación')).toBeNull();
  });
});

describe('Cambios de personas', () => {
  const items = [
    change({ reason: '<script>alert(1)</script> Cubre las aprobaciones' }),
    change({
      change_id: '2'.repeat(32),
      kind: 'disable',
      group: null,
      target_email: 'usuario6@example.com',
      proposed_by: ME.user_id,
    }),
    change({
      change_id: '3'.repeat(32),
      kind: 'remove',
      group: 'finops-central',
      target_user: ME.user_id,
      target_email: ME.email,
    }),
    change({
      change_id: '4'.repeat(32),
      kind: 'enable',
      group: null,
      target_email: 'usuario9@example.com',
      status: 'expired',
    }),
  ];

  it('titles each change, and offers only what the API would accept', async () => {
    const { container } = renderTab(
      apiWith({ searchPeople: directory([person()]), getMemberChanges: { items } }),
    );
    const section = (await screen.findByRole('heading', { name: 'Cambios de personas' })).closest(
      'section',
    ) as HTMLElement;
    const cards = within(section).getAllByRole('article');
    expect(cards[0]).toHaveTextContent('Dar mango-admin a usuario2@example.com');
    expect(cards[0]).toHaveTextContent('<script>alert(1)</script> Cubre las aprobaciones');
    expect(container.querySelector('script')).toBeNull();
    expect(within(cards[0] as HTMLElement).getByRole('button', { name: 'Aprobar' })).toBeEnabled();
    // Who proposed only withdraws.
    expect(cards[1]).toHaveTextContent('Deshabilitar el acceso de usuario6@example.com');
    expect(cards[1]).toHaveTextContent('Tu propuesta');
    expect(within(cards[1] as HTMLElement).getByRole('button', { name: 'Retirar' })).toBeEnabled();
    expect(within(cards[1] as HTMLElement).queryByRole('button', { name: 'Aprobar' })).toBeNull();
    // About the own account: another administrator decides.
    expect(cards[2]).toHaveTextContent(`Quitar finops-central a ${ME.email}`);
    expect(cards[2]).toHaveTextContent('Es sobre tu cuenta: la debe aprobar otro admin');
    expect(within(cards[2] as HTMLElement).queryByRole('button')).toBeNull();
    expect(cards[3]).toHaveTextContent('Rehabilitar el acceso de usuario9@example.com');
    expect(cards[3]).toHaveTextContent('Nadie la aprobó en 72 h');
    expect(within(cards[3] as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('approves, rejects with a reason and withdraws through their endpoints', async () => {
    let current = items;
    const call = apiWith({
      searchPeople: directory([person()]),
      getMemberChanges: () => ({ items: current }),
      approveMemberChange: () => {
        current = current.map((item, index) =>
          index === 0 ? { ...item, status: 'approved' as const } : item,
        );
        return { items: current };
      },
      rejectMemberChange: { items },
      withdrawMemberChange: { items },
    });
    const { user } = renderTab(call);
    const cards = await screen.findAllByRole('article');
    await user.click(within(cards[1] as HTMLElement).getByRole('button', { name: 'Retirar' }));
    await waitFor(() => {
      expect(calls(call, 'withdrawMemberChange')).toEqual([
        { path: { change_id: '2'.repeat(32) }, body: {} },
      ]);
    });
    await user.click(within(cards[0] as HTMLElement).getByRole('button', { name: 'Rechazar' }));
    const note = within(cards[0] as HTMLElement).getByLabelText('Motivo del rechazo');
    expect(note).toHaveFocus();
    const reject = within(cards[0] as HTMLElement).getAllByRole('button', { name: 'Rechazar' })[1];
    expect(reject).toBeDisabled();
    await user.type(note, 'No hace falta');
    await user.click(reject as HTMLElement);
    await waitFor(() => {
      expect(calls(call, 'rejectMemberChange')).toEqual([
        { path: { change_id: 'c'.repeat(32) }, body: { reason: 'No hace falta' } },
      ]);
    });
    await user.click(within(cards[0] as HTMLElement).getByRole('button', { name: 'Aprobar' }));
    expect(await screen.findByText('Aprobado')).toBeInTheDocument();
    expect(calls(call, 'approveMemberChange')).toEqual([
      { path: { change_id: 'c'.repeat(32) }, body: {} },
    ]);
  });

  it.each([
    [new ApiError(409, 'version_conflict', 'the change moved; reload')],
    [new ApiError(410, 'expired', 'the change expired')],
  ])('says a change is no longer pending and reloads (%s)', async (failure) => {
    const call = apiWith({
      searchPeople: directory([person()]),
      getMemberChanges: { items },
      approveMemberChange: failure,
    });
    const { user } = renderTab(call);
    const cards = await screen.findAllByRole('article');
    await user.click(within(cards[0] as HTMLElement).getByRole('button', { name: 'Aprobar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La solicitud ya no está pendiente: otro admin la decidió o venció.',
    );
    await waitFor(() => {
      expect(calls(call, 'getMemberChanges')).toHaveLength(2);
    });
  });
});

describe('Cambios de personas: lo que la API comprueba otra vez al aprobar', () => {
  const pending = [change()];

  it.each([
    ['user_disabled', 'la persona fue deshabilitada'],
    ['already_member', 'la persona ya tiene ese grupo'],
    ['last_admins', 'quedarían menos de dos administradores'],
  ])('says why %s kept the change pending', async (code, why) => {
    const call = apiWith({
      searchPeople: directory([person()]),
      getMemberChanges: { items: pending },
      approveMemberChange: new ApiError(409, code, 'server words'),
    });
    const { user } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: 'Aprobar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `No se pudo aprobar cccccccc: ${why}. El cambio sigue pendiente.`,
    );
    expect(screen.queryByText('server words')).toBeNull();
    expect(screen.getByText('Pendiente')).toBeInTheDocument();
  });

  it.each([
    [422, 'unknown_group', 'el grupo bu-finanzas ya no existe'],
    [409, 'not_member', 'la persona ya no tiene ese grupo'],
    [409, 'already_disabled', 'la persona ya está deshabilitada'],
    [409, 'already_enabled', 'la persona ya está habilitada'],
  ])('says a change no longer applies (%s %s)', async (status, code, why) => {
    const call = apiWith({
      searchPeople: directory([person()]),
      getMemberChanges: { items: [change({ group: 'bu-finanzas' })] },
      approveMemberChange: new ApiError(status, code, 'server words'),
    });
    const { user } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: 'Aprobar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `No se pudo aprobar cccccccc: ${why}. El cambio ya no aplica: retíralo o recházalo.`,
    );
    expect(screen.queryByText('server words')).toBeNull();
  });

  it('tells an administrator who stopped being one to sign in again', async () => {
    const call = apiWith({
      searchPeople: directory([person()]),
      getMemberChanges: { items: pending },
      approveMemberChange: new ApiError(403, 'forbidden', 'not allowed'),
    });
    const { user } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: 'Aprobar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ya no tienes permiso de administrador: tus acciones en Personas se rechazan. Vuelve a entrar para actualizar tu sesión.',
    );
  });
});

describe('Personas de otra empresa', () => {
  it('marks them «Externa» in the list and in the panel', async () => {
    const own = person({ email: 'ana@example.org' });
    const other = person({ email: 'luis@otra.com' });
    const call = apiWith({ searchPeople: directory([own, other]) });
    const { user } = renderTab(call);
    const row = await screen.findByRole('button', { name: `Gestionar ${other.email}` });
    expect(within(row).getByText('Externa')).toHaveAttribute(
      'title',
      'Su dominio no es de los que se registran solos',
    );
    expect(
      within(screen.getByRole('button', { name: `Gestionar ${own.email}` })).queryByText('Externa'),
    ).toBeNull();
    const panel = await openPanel(user, other.email);
    expect(within(panel).getByText('Externa · invitada de otra empresa')).toBeInTheDocument();
  });

  it('marks nobody when the installation has no list of domains', async () => {
    const call = apiWith({ searchPeople: directory([person({ email: 'luis@otra.com' })]) });
    renderTab(call, {}, { domains: [] });
    await screen.findByRole('button', { name: 'Gestionar luis@otra.com' });
    expect(screen.queryByText('Externa')).toBeNull();
  });
});

describe('Restablecimientos de MFA', () => {
  it('lists the resets under the people and decides them', async () => {
    let resets = [reset()];
    const approveMfaReset = vi.fn(() => {
      resets = [reset({ status: 'approved' })];
      return Promise.resolve(resets);
    });
    const call = apiWith({ searchPeople: directory([person()]) });
    const { user } = renderTab(call, {
      listMfaResets: vi.fn(() => Promise.resolve(resets)),
      approveMfaReset,
    });
    expect(await screen.findByText('Restablecimientos de MFA')).toBeInTheDocument();
    const card = screen.getByRole('article');
    expect(card).toHaveTextContent('Restablecer MFA de usuario3@example.com');
    await user.click(within(card).getByRole('button', { name: 'Aprobar' }));
    expect(await screen.findByText('Aprobado')).toBeInTheDocument();
    expect(approveMfaReset).toHaveBeenCalledWith('d'.repeat(32));
    // The person is left without MFA: the directory is read again.
    await waitFor(() => {
      expect(calls(call, 'searchPeople').length).toBeGreaterThan(1);
    });
  });

  it('says a reset is no longer pending, and that the list could not be loaded', async () => {
    const call = apiWith({ searchPeople: directory([person()]) });
    const { user, unmount } = renderTab(call, {
      listMfaResets: vi.fn(() => Promise.resolve([reset()])),
      approveMfaReset: vi.fn(() => Promise.reject(new ApiError(410, 'expired', 'expired'))),
    });
    await user.click(await screen.findByRole('button', { name: 'Aprobar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La solicitud ya no está pendiente: otro admin la decidió o venció.',
    );
    unmount();

    renderTab(apiWith({ searchPeople: directory([person()]) }), {
      listMfaResets: vi.fn(() => Promise.reject(new Error('down'))),
    });
    expect(await screen.findByText('Restablecimientos de MFA')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No se pudo completar la acción. Inténtalo de nuevo.',
    );
  });
});
