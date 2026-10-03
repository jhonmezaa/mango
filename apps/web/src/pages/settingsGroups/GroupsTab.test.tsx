import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { GroupsTab } from './GroupsTab';
import type { Group, GroupChange, GroupsAdmin } from './model';

const XSS = '<img src=x onerror=alert(1)>';
const ME = 'admin-1';
const FUTURE = '2999-01-01T00:00:00+00:00';
const OU = 'ou-abcd-11111111';

function group(overrides: Partial<Group> & Pick<Group, 'id' | 'type'>): Group {
  return {
    area: null,
    description: '',
    version: 3,
    system: false,
    fixed_type: false,
    agents: [],
    ...overrides,
  };
}

function change(
  overrides: Partial<GroupChange> & Pick<GroupChange, 'kind' | 'group_id'>,
): GroupChange {
  return {
    change_id: 'a'.repeat(32),
    status: 'pending',
    before: null,
    after: null,
    agents: 0,
    proposed_by: 'admin-2',
    proposed_by_email: 'otra.admin@example.com',
    reason: 'Equipo nuevo',
    created_at: new Date().toISOString(),
    expires_at: FUTURE,
    decided_by: null,
    decided_by_email: null,
    decided_at: null,
    note: null,
    ...overrides,
  };
}

const finops = group({
  id: 'finops-central',
  type: 'central',
  description: 'FinOps central',
  system: true,
  fixed_type: true,
  agents: [{ id: 'finops', name: 'FinOps', account_data: false }],
});
const platform = group({
  id: 'platform',
  type: 'central',
  description: 'Plataforma y SRE',
  agents: [
    { id: 'k3fq7zr2m5xw6n4a', name: XSS, account_data: true },
    { id: 'b3fq7zr2m5xw6n4a', name: 'Alarmas', account_data: true },
  ],
});
const finance = group({
  id: 'bu-finanzas',
  type: 'area',
  area: 'finanzas',
  description: XSS,
  fixed_type: true,
});
const people = group({ id: 'people', type: 'general', description: 'Personas y Cultura' });
const ALL = [finance, finops, people, platform];

function view(items: Group[] = ALL, changes: GroupChange[] = []): GroupsAdmin {
  return { items, changes };
}

/** An API whose list is `initial` and whose writes answer with `next`. */
function apiWith(initial: GroupsAdmin, next: Partial<Record<string, unknown>> = {}) {
  return vi.fn((operation: string) => {
    const answer = operation === 'getAdminGroups' ? initial : next[operation];
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${operation}`));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
}

function renderTab(call: ReturnType<typeof vi.fn>, me: Partial<typeof baseMe> = {}) {
  const notify = vi.fn();
  const onGoAreas = vi.fn();
  const onForbidden = vi.fn();
  const api = {
    call,
    getBusinessUnits: vi.fn(() =>
      Promise.resolve({ version: 1, units: { finanzas: [OU], retail: [OU, OU] }, pending: [] }),
    ),
  } as unknown as ApiClient;
  const result = render(
    <TestProviders
      session={sessionValue({ api, me: { ...baseMe, user_id: ME, is_admin: true, ...me } })}
    >
      <GroupsTab notify={notify} onForbidden={onForbidden} onGoAreas={onGoAreas} />
    </TestProviders>,
  );
  return { ...result, notify, onGoAreas, onForbidden, user: userEvent.setup() };
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing element');
  return value;
}

function rows() {
  return within(screen.getByRole('list', { name: 'Grupos de acceso' })).getAllByRole('listitem');
}

function bodyOf(call: ReturnType<typeof vi.fn>, operation: string): unknown {
  const found = call.mock.calls.find(([name]) => name === operation);
  return (found?.[1] as { body?: unknown } | undefined)?.body;
}

describe('GroupsTab (design groups-admin.jsx)', () => {
  it('lists the groups with type, area and agents, and renders API text as text', async () => {
    const { container } = renderTab(apiWith(view()));
    expect(await screen.findByRole('heading', { name: 'Grupos de acceso' })).toBeVisible();
    expect(rows().map((row) => within(row).getAllByText(/./)[0]?.textContent)).toEqual([
      'bu-finanzas',
      'finops-central',
      'people',
      'platform',
    ]);
    const [financeRow, finopsRow, peopleRow, platformRow] = rows();
    expect(within(must(financeRow)).getByText('De área')).toBeVisible();
    expect(within(must(financeRow)).getByText('finanzas')).toBeVisible();
    // The description is another admin's text: shown literally, never as markup.
    expect(within(must(financeRow)).getByText(XSS)).toBeVisible();
    expect(container.querySelector('img')).toBeNull();
    expect(within(must(finopsRow)).getByText('Central')).toHaveAttribute(
      'title',
      'Puede usar tools de «Datos de cuentas»',
    );
    expect(within(must(peopleRow)).getByText('General')).toBeVisible();
    expect(within(must(platformRow)).getByText('2')).toBeVisible();
    // The directory's membership is not read by the API: no number is invented.
    expect(
      within(must(platformRow)).getByTitle('Todavía no hay dato de miembros'),
    ).toHaveTextContent('—');
    expect(
      screen.getByText(/la propuesta vence a las 72 h\. Los grupos del sistema no se eliminan\./),
    ).toBeVisible();
    expect(screen.queryByText('Cambios de grupos')).toBeNull();
  });

  it('filters by type and by text, with the count of each type', async () => {
    const { user } = renderTab(apiWith(view()));
    await screen.findByRole('heading', { name: 'Grupos de acceso' });
    const filters = screen.getByRole('group', { name: 'Tipo' });
    expect(within(filters).getByRole('button', { name: /^Todos\s*4$/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(filters).getByRole('button', { name: /^Centrales\s*2$/ }));
    expect(rows()).toHaveLength(2);
    await user.type(screen.getByRole('searchbox', { name: 'Buscar grupos' }), 'SRE');
    expect(rows()).toHaveLength(1);
    await user.click(within(filters).getByRole('button', { name: /^Generales\s*1$/ }));
    expect(screen.getByText('Ningún grupo coincide.')).toBeVisible();
  });

  it('proposes a new group after checking name and reason', async () => {
    const call = apiWith(view(), { postGroupChange: { change_id: 'b'.repeat(32) } });
    const { user, notify } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: 'Nuevo grupo' }));
    const dialog = screen.getByRole('dialog', { name: 'Nuevo grupo' });
    const submit = within(dialog).getByRole('button', { name: 'Enviar a aprobación' });

    await user.click(submit);
    expect(within(dialog).getByText('Escribe un nombre')).toBeVisible();
    const name = within(dialog).getByLabelText('Nombre');
    await user.type(name, 'Finanzas Líderes');
    expect(within(dialog).getByText('Minúsculas, números y guiones (2 a 32)')).toBeVisible();
    await user.clear(name);
    await user.type(name, 'people');
    expect(within(dialog).getByText('Ya existe un grupo con ese nombre')).toBeVisible();
    await user.clear(name);
    await user.type(name, 'mango-ops');
    expect(
      within(dialog).getByText('Ese nombre está reservado para grupos del sistema.'),
    ).toBeVisible();
    await user.clear(name);
    await user.type(name, 'finanzas-lideres');
    await user.click(submit);
    expect(within(dialog).getByText('Escribe el motivo')).toBeVisible();
    // The name fixes the type: an area group is `bu-<área>`, and `bu-*` is only an area group.
    await user.click(within(dialog).getByRole('radio', { name: /De área/ }));
    expect(
      within(dialog).getByText(
        'Los grupos de área se nombran «bu-<área>»: el tipo lo fija el nombre.',
      ),
    ).toBeVisible();
    await user.clear(name);
    await user.type(name, 'bu-retail');
    await user.click(within(dialog).getByRole('radio', { name: /General/ }));
    expect(
      within(dialog).getByText(
        'Los grupos que empiezan por «bu-» son de área: el tipo lo fija el nombre.',
      ),
    ).toBeVisible();
    await user.click(submit);
    expect(bodyOf(call, 'postGroupChange')).toBeUndefined();

    expect(
      within(dialog).getByText(
        'El grupo no se aplica hasta que otro admin lo apruebe. Si nadie lo decide en 72 h, vence.',
      ),
    ).toBeVisible();
    await user.type(within(dialog).getByLabelText('Descripción'), '  Líderes de Finanzas ');
    await user.click(within(dialog).getByRole('radio', { name: /De área/ }));
    // The first area of the mapping is preselected; the option shows its OUs.
    expect(within(dialog).getByRole('option', { name: 'finanzas · 1 OU' })).toBeVisible();
    await user.selectOptions(within(dialog).getByLabelText('Área'), 'retail');
    await user.type(within(dialog).getByLabelText('Motivo'), ' Equipo nuevo ');
    await user.click(submit);

    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Propuesta enviada · la debe aprobar otro admin');
    });
    expect(bodyOf(call, 'postGroupChange')).toEqual({
      kind: 'create',
      group_id: 'bu-retail',
      type: 'area',
      area: 'retail',
      description: 'Líderes de Finanzas',
      reason: 'Equipo nuevo',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('links to Áreas y OUs when the area is missing', async () => {
    const { user, onGoAreas } = renderTab(apiWith(view()));
    await user.click(await screen.findByRole('button', { name: 'Nuevo grupo' }));
    await user.click(screen.getByRole('radio', { name: /De área/ }));
    await user.click(screen.getByRole('button', { name: 'Propónla en Áreas y OUs' }));
    expect(onGoAreas).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('saves the description alone, without approval', async () => {
    const renamed = { ...people, description: 'Personas', version: 4 };
    const call = apiWith(view(), {
      putGroupDescription: view([finance, finops, renamed, platform]),
    });
    const { user, notify } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: 'Editar people' }));
    const dialog = screen.getByRole('dialog', { name: 'Editar people' });
    expect(within(dialog).getByLabelText('Nombre')).toBeDisabled();
    expect(within(dialog).queryByLabelText('Motivo')).toBeNull();
    const description = within(dialog).getByLabelText('Descripción');
    await user.clear(description);
    await user.type(description, 'Personas');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Descripción actualizada');
    });
    expect(call).toHaveBeenCalledWith('putGroupDescription', {
      path: { group_id: 'people' },
      body: { version: 3, description: 'Personas' },
    });
    expect(within(must(rows()[2])).getByText('Personas')).toBeVisible();
  });

  it('sends a change of type to approval with the version it was made on', async () => {
    const call = apiWith(view(), { postGroupChange: { change_id: 'b'.repeat(32) } });
    const { user } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: 'Editar people' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /Central/ }));
    expect(
      within(dialog).getByText(
        'El cambio de tipo o área no se aplica hasta que otro admin lo apruebe. Si nadie lo decide en 72 h, vence.',
      ),
    ).toBeVisible();
    await user.type(within(dialog).getByLabelText('Motivo'), 'Pasa a plataforma');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar a aprobación' }));
    await waitFor(() => {
      expect(bodyOf(call, 'postGroupChange')).toEqual({
        kind: 'update',
        group_id: 'people',
        type: 'central',
        area: null,
        description: 'Personas y Cultura',
        base_version: 3,
        reason: 'Pasa a plataforma',
      });
    });
  });

  it('does not let an admin change the type of a group they belong to', async () => {
    const call = apiWith(view());
    const { user } = renderTab(call, { groups: ['mango-admin', 'people'] });
    await user.click(await screen.findByRole('button', { name: 'Editar people' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /Central/ }));
    await user.type(within(dialog).getByLabelText('Motivo'), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar a aprobación' }));
    expect(
      within(dialog).getByText(
        'No puedes cambiar un grupo al que perteneces. Pídeselo a otro administrador.',
      ),
    ).toBeVisible();
    expect(bodyOf(call, 'postGroupChange')).toBeUndefined();
  });

  it('says when the registry is full instead of sending the request', async () => {
    const many = Array.from({ length: 100 }, (_, index) =>
      group({ id: `equipo-${String(index)}`, type: 'general' }),
    );
    const call = apiWith(view(many));
    const { user } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: 'Nuevo grupo' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Nombre'), 'uno-mas');
    await user.type(within(dialog).getByLabelText('Motivo'), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar a aprobación' }));
    expect(
      within(dialog).getByText(
        'Se alcanzó el máximo de 100 grupos registrados. Propón eliminar alguno antes de crear otro.',
      ),
    ).toBeVisible();
    expect(bodyOf(call, 'postGroupChange')).toBeUndefined();
  });

  it('keeps a group central while agents use it with account data', async () => {
    const call = apiWith(view());
    const { user, container } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: 'Editar platform' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(`2 agentes usan este grupo: ${XSS}, Alarmas.`)).toBeVisible();
    await user.click(within(dialog).getByRole('radio', { name: /General/ }));
    await user.type(within(dialog).getByLabelText('Motivo'), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar a aprobación' }));
    expect(
      within(dialog).getByText(
        `No puede dejar de ser central: ${XSS}, Alarmas lo usan con tools de «Datos de cuentas».`,
      ),
    ).toBeVisible();
    expect(container.ownerDocument.querySelector('img')).toBeNull();
    expect(bodyOf(call, 'postGroupChange')).toBeUndefined();
  });

  it('proposes a deletion with a reason, and never for a system group', async () => {
    const call = apiWith(view(), { postGroupChange: { change_id: 'b'.repeat(32) } });
    const { user } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: 'Editar finops-central' }));
    const system = within(screen.getByRole('dialog')).getByRole('button', { name: 'Eliminar' });
    expect(system).toBeDisabled();
    expect(system).toHaveAttribute('title', 'Grupo del sistema');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }));

    await user.click(screen.getByRole('button', { name: 'Editar platform' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    expect(within(dialog).getByText('Lo usan agentes; perderán este acceso.')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Enviar a aprobación' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Proponer eliminación' }));
    expect(within(dialog).getByText('Escribe el motivo')).toBeVisible();
    await user.type(within(dialog).getByLabelText('Motivo'), 'Ya no existe el equipo');
    await user.click(within(dialog).getByRole('button', { name: 'Proponer eliminación' }));
    await waitFor(() => {
      expect(bodyOf(call, 'postGroupChange')).toEqual({
        kind: 'delete',
        group_id: 'platform',
        base_version: 3,
        reason: 'Ya no existe el equipo',
      });
    });
  });

  it('shows what the server refused inside the dialog, in the words of the app', async () => {
    const call = apiWith(view(), {
      postGroupChange: new ApiError(422, 'group_referenced', 'that name is in use <b>'),
    });
    const { user, notify } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: 'Nuevo grupo' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Nombre'), 'legal');
    await user.type(within(dialog).getByLabelText('Motivo'), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar a aprobación' }));
    expect(
      await within(dialog).findByText('Hay agentes que todavía usan ese nombre. Elige otro.'),
    ).toBeVisible();
    expect(screen.queryByText(/that name is in use/)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it('marks groups with an open request and lists pending creations', async () => {
    const changes = [
      change({
        kind: 'update',
        group_id: 'people',
        before: { type: 'general', area: null },
        after: { type: 'area', area: 'retail', description: null },
      }),
      change({ change_id: 'b'.repeat(32), kind: 'delete', group_id: 'platform', agents: 2 }),
      change({
        change_id: 'c'.repeat(32),
        kind: 'create',
        group_id: 'legal',
        after: { type: 'central', area: null, description: 'Legal' },
        reason: XSS,
      }),
    ];
    const { container } = renderTab(apiWith(view(ALL, changes)));
    await screen.findByRole('heading', { name: 'Cambios de grupos' });
    const [, , peopleRow, platformRow, legalRow] = rows();
    expect(within(must(peopleRow)).getByText('Cambio pendiente')).toBeVisible();
    expect(within(must(peopleRow)).getByRole('button', { name: 'Editar people' })).toBeDisabled();
    expect(within(must(platformRow)).getByText('Eliminación pendiente')).toBeVisible();
    expect(within(must(legalRow)).getByText('Creación pendiente')).toBeVisible();
    expect(within(must(legalRow)).getByText('Central')).toBeVisible();
    expect(within(must(legalRow)).queryByRole('button')).toBeNull();

    expect(screen.getByText('Tipo general → de área (retail)')).toBeVisible();
    expect(screen.getByText('Lo usan 2 agentes; perderán este acceso')).toBeVisible();
    expect(screen.getByText('Nuevo grupo central')).toBeVisible();
    // The description of bu-finanzas and the reason of the request, both as text.
    expect(screen.getAllByText(XSS)).toHaveLength(2);
    expect(container.querySelector('img')).toBeNull();
  });

  it('lets another admin approve or reject, and only the proposer withdraw', async () => {
    const mine = change({
      change_id: 'b'.repeat(32),
      kind: 'create',
      group_id: 'legal',
      proposed_by: ME,
      after: { type: 'general', area: null, description: '' },
    });
    const theirs = change({ kind: 'delete', group_id: 'people' });
    const approved = view(
      [finance, finops, platform],
      [{ ...theirs, status: 'approved', decided_by: ME, decided_by_email: 'yo@example.com' }, mine],
    );
    const call = apiWith(view(ALL, [theirs, mine]), {
      approveGroupChange: approved,
      rejectGroupChange: view(ALL, [mine]),
      withdrawGroupChange: view(ALL, [theirs]),
    });
    const { user } = renderTab(call);
    const list = must(
      (await screen.findByRole('heading', { name: 'Cambios de grupos' })).closest('section'),
    );
    const [theirCard, myCard] = within(list).getAllByRole('article');
    expect(within(must(myCard)).getByText('Tu propuesta')).toBeVisible();
    expect(within(must(myCard)).getByText('Otro admin debe aprobarla')).toBeVisible();
    expect(within(must(myCard)).queryByRole('button', { name: 'Aprobar' })).toBeNull();
    expect(within(must(theirCard)).getByText('Propuesta de otra.admin@example.com')).toBeVisible();
    expect(within(must(theirCard)).queryByRole('button', { name: 'Retirar' })).toBeNull();

    // Rejecting needs a note.
    await user.click(within(must(theirCard)).getByRole('button', { name: 'Rechazar' }));
    const note = within(must(theirCard)).getByRole('textbox', { name: 'Motivo del rechazo' });
    expect(note).toHaveFocus();
    const confirm = must(within(must(theirCard)).getAllByRole('button', { name: 'Rechazar' })[1]);
    expect(confirm).toBeDisabled();
    await user.click(within(must(theirCard)).getByRole('button', { name: 'Cancelar' }));

    await user.click(within(must(theirCard)).getByRole('button', { name: 'Aprobar' }));
    await waitFor(() => {
      expect(screen.getByText('Aprobó yo@example.com')).toBeVisible();
    });
    expect(call).toHaveBeenCalledWith('approveGroupChange', {
      path: { change_id: 'a'.repeat(32) },
      body: {},
    });
    expect(screen.queryByRole('button', { name: 'Editar people' })).toBeNull();
  });

  it('sends the reject note and the withdrawal', async () => {
    const mine = change({
      change_id: 'b'.repeat(32),
      kind: 'delete',
      group_id: 'people',
      proposed_by: ME,
    });
    const theirs = change({ kind: 'delete', group_id: 'platform' });
    const call = apiWith(view(ALL, [theirs, mine]), {
      rejectGroupChange: view(ALL, [{ ...theirs, status: 'rejected', note: 'Duplicado' }, mine]),
      withdrawGroupChange: view(ALL, [{ ...mine, status: 'withdrawn' }]),
    });
    const { user } = renderTab(call);
    const [theirCard] = await screen.findAllByRole('article');
    await user.click(within(must(theirCard)).getByRole('button', { name: 'Rechazar' }));
    await user.type(within(must(theirCard)).getByRole('textbox'), ' Duplicado ');
    await user.click(must(within(must(theirCard)).getAllByRole('button', { name: 'Rechazar' })[1]));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('rejectGroupChange', {
        path: { change_id: 'a'.repeat(32) },
        body: { reason: 'Duplicado' },
      });
    });
    expect(await screen.findByText('Rechazado')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retirar' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('withdrawGroupChange', {
        path: { change_id: 'b'.repeat(32) },
        body: {},
      });
    });
    expect(await screen.findByText('Retirado')).toBeVisible();
  });

  it('explains a decision the server refused and reloads stale data', async () => {
    const theirs = change({ kind: 'delete', group_id: 'people' });
    const call = apiWith(view(ALL, [theirs]), {
      approveGroupChange: new ApiError(409, 'version_conflict', 'x'),
    });
    const { user } = renderTab(call);
    await user.click(await screen.findByRole('button', { name: 'Aprobar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La solicitud ya no está pendiente: otro admin la decidió o venció.',
    );
    await waitFor(() => {
      expect(call.mock.calls.filter(([name]) => name === 'getAdminGroups')).toHaveLength(2);
    });
  });

  it('does not offer a decision on a group the admin belongs to (the API refuses it)', async () => {
    const theirs = change({
      kind: 'update',
      group_id: 'people',
      before: { type: 'general', area: null },
      after: { type: 'central', area: null, description: null },
    });
    renderTab(apiWith(view(ALL, [theirs])), { groups: ['mango-admin', 'people'] });
    const card = must((await screen.findAllByRole('article'))[0]);
    expect(
      within(card).getByText('Perteneces a este grupo: la debe decidir otro admin'),
    ).toBeVisible();
    expect(within(card).queryByRole('button', { name: 'Aprobar' })).toBeNull();
  });

  it('shows closed and expired requests with their status', async () => {
    renderTab(
      apiWith(
        view(ALL, [
          change({ kind: 'delete', group_id: 'people', status: 'expired' }),
          change({
            change_id: 'b'.repeat(32),
            kind: 'delete',
            group_id: 'platform',
            status: 'rejected',
            decided_by: 'admin-3',
            note: XSS,
          }),
        ]),
      ),
    );
    expect(await screen.findByText('Nadie la aprobó en 72 h')).toBeVisible();
    expect(screen.getByText('Vencido')).toBeVisible();
    expect(screen.getByText('Rechazó admin-3')).toBeVisible();
    expect(screen.getAllByText(XSS)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Aprobar' })).toBeNull();
    // An expired or closed request no longer blocks editing the group.
    expect(screen.getByRole('button', { name: 'Editar people' })).toBeEnabled();
  });

  it('reports a load failure and a 403 to the page', async () => {
    const { onForbidden, user } = renderTab(
      vi.fn(() => Promise.reject(new ApiError(403, 'forbidden', 'x'))),
    );
    expect(await screen.findByText('No pudimos cargar los grupos')).toBeVisible();
    expect(onForbidden).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: /Reintentar/ }));
    expect(await screen.findByText('No pudimos cargar los grupos')).toBeVisible();
  });
});
