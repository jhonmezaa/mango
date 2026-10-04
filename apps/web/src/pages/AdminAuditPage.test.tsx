import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient, AuditListOptions } from '../api/client';
import { ApiError } from '../api/errors';
import type { AuditEvent } from '../api/schemas';
import { baseMe, sessionValue } from '../test/fixtures';
import { TestProviders } from '../test/TestProviders';
import { AdminAuditPage } from './AdminAuditPage';

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const EVENTS: AuditEvent[] = [
  {
    event_id: 'e1'.padEnd(32, '0'),
    ts: iso(1),
    event: 'settings.budget.updated',
    user_id: 'sub-ana',
    actor_email: 'ana@example.com',
    actor_role: 'finops-central',
    actor_is_admin: true,
    resource: { type: 'user_budget', id: 'u-2' },
    hash: 'a'.repeat(64),
    detail: {
      scope: 'USER#u-2',
      target_user: 'u-2',
      before: { limit_usd: null },
      after: { limit_usd: '150.00' },
      outcome: 'applied',
    },
  },
  {
    // Written before the API recorded the actor: the row shows the sub, without role.
    event_id: 'e2'.padEnd(32, '0'),
    ts: iso(2),
    event: 'settings.bu_mapping.rejected',
    user_id: 'luis@example.com',
    hash: 'b'.repeat(64),
    detail: { change_id: 'CHG-1', withdrawn: false, reason: '<img src=x onerror=alert(1)>' },
  },
  {
    event_id: 'e3'.padEnd(32, '0'),
    ts: iso(3),
    event: 'agent.invoke',
    user_id: 'sub-ana',
    actor_email: 'ana@example.com',
    actor_role: 'finops-central',
    actor_is_admin: true,
    hash: 'c'.repeat(64),
    detail: { conversation_id: 'conv-1', agent: 'finops' },
  },
];

const page = (items: AuditEvent[], next: string | null = null) =>
  Promise.resolve({ items, next_cursor: next });

function renderPage(api: Partial<ApiClient>, path = '/audit', isAdmin = true) {
  return render(
    <TestProviders
      path={path}
      session={sessionValue({
        api: { listAuditEvents: vi.fn(() => page(EVENTS)), ...api } as ApiClient,
        me: { ...baseMe, is_admin: isAdmin },
      })}
    >
      <AdminAuditPage />
    </TestProviders>,
  );
}

describe('AdminAuditPage', () => {
  it('groups events by day with the design labels, rendering details as text', async () => {
    const { container } = renderPage({});
    expect(await screen.findByRole('heading', { name: /Hoy/ })).toBeInTheDocument();
    expect(screen.getByText('Límite de usuario')).toBeInTheDocument();
    expect(screen.getByText('Límite propio USD 150,00')).toBeInTheDocument();
    expect(screen.getByText('Cambio de áreas rechazado')).toBeInTheDocument();
    expect(
      screen.getByText('Propuesta rechazada — "<img src=x onerror=alert(1)>"'),
    ).toBeInTheDocument();
    // A turn start whose chat query is not loaded stays a row, with the design label.
    expect(screen.getByText('Inicio de turno del agente')).toBeInTheDocument();
    expect(container.querySelector('img, script')).toBeNull();
    expect(screen.getByText('3 eventos')).toBeInTheDocument();
  });

  it('filters by category, actor and search, and clears', async () => {
    const user = userEvent.setup();
    renderPage({});
    await screen.findByText('Límite de usuario');
    const cats = screen.getByRole('group', { name: 'Categoría' });
    await user.click(within(cats).getByRole('button', { name: /Presupuestos/ }));
    expect(screen.getByText('1 evento')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Limpiar' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Persona o agente' }),
      'luis@example.com',
    );
    expect(screen.getByText('1 evento')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Limpiar' }));
    await user.type(screen.getByRole('textbox', { name: 'Buscar en el audit log' }), 'conv-1');
    expect(screen.getByText('1 evento')).toBeInTheDocument();
  });

  it('starts on the category from the URL (link from Áreas y OUs)', async () => {
    renderPage({}, '/audit?cat=config');
    expect(await screen.findByText('Cambio de áreas rechazado')).toBeInTheDocument();
    expect(screen.queryByText('Límite de usuario')).toBeNull();
  });

  it('opens the side panel with before/after and filters by resource', async () => {
    const user = userEvent.setup();
    renderPage({});
    await user.click(await screen.findByText('Límite de usuario'));
    const panel = screen.getByRole('dialog', { name: 'Límite de usuario' });
    expect(within(panel).getByText('Qué cambió')).toBeInTheDocument();
    expect(within(panel).getByText('limit_usd')).toBeInTheDocument();
    expect(within(panel).getByText('150.00')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: /Historial de este recurso/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('u-2', { selector: '.au-pill .mono' })).toBeInTheDocument();
    expect(screen.getByText('1 evento')).toBeInTheDocument();
  });

  it('shows the recorded role and the event id', async () => {
    const user = userEvent.setup();
    renderPage({});
    const row = (await screen.findByText('Límite de usuario')).closest('button');
    expect(row).not.toBeNull();
    // The end of the email is always shown and the badge is short; the tooltip has both in full.
    const actor = within(row as HTMLElement).getByTitle('ana@example.com · FinOps central · Admin');
    expect(actor.querySelector('.au-local')).toBeEmptyDOMElement();
    expect(actor.querySelector('.au-dom')).toHaveTextContent('ana@example.com');
    expect(actor.querySelector('.au-role')).toHaveTextContent('Admin');
    const old = screen.getByText('Cambio de áreas rechazado').closest('button') as HTMLElement;
    expect(old.querySelector('.au-role')).toBeNull();
    await user.click(row as HTMLElement);
    const panel = screen.getByRole('dialog', { name: 'Límite de usuario' });
    expect(within(panel).getByText('e1'.padEnd(32, '0'))).toBeInTheDocument();
    // Searching by event id (design placeholder "…persona o ID").
    await user.click(within(panel).getByRole('button', { name: 'Cerrar' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Buscar en el audit log' }),
      'e2'.padEnd(32, '0'),
    );
    expect(screen.getByText('1 evento')).toBeInTheDocument();
  });

  it('asks the server for the period', async () => {
    const user = userEvent.setup();
    const listAuditEvents = vi.fn<(options?: AuditListOptions) => ReturnType<typeof page>>(() =>
      page(EVENTS),
    );
    renderPage({ listAuditEvents });
    await screen.findByText('Límite de usuario');
    expect(listAuditEvents).toHaveBeenLastCalledWith({
      limit: 100,
      since: null,
      excludeReads: true,
    });
    await user.click(screen.getByRole('button', { name: '7 días' }));
    await screen.findByText('Límite de usuario');
    const options = listAuditEvents.mock.calls.at(-1)?.[0];
    const since = options?.since?.getTime() ?? 0;
    expect(Math.abs(Date.now() - 7 * 86_400_000 - since)).toBeLessThan(60_000);
  });

  it('hides reads by default and asks the server again when "Mostrar lecturas" changes', async () => {
    const user = userEvent.setup();
    const listAuditEvents = vi.fn<(options?: AuditListOptions) => ReturnType<typeof page>>(() =>
      page(EVENTS),
    );
    renderPage({ listAuditEvents });
    await screen.findByText('Límite de usuario');
    const toggle = screen.getByRole('switch', { name: 'Mostrar lecturas' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('button', { name: 'Limpiar' })).toBeNull();
    await user.click(toggle);
    await screen.findByText('Límite de usuario');
    expect(listAuditEvents).toHaveBeenLastCalledWith({
      limit: 100,
      since: null,
      excludeReads: false,
    });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    // "Limpiar" also turns it off.
    await user.click(screen.getByRole('button', { name: 'Limpiar' }));
    await screen.findByText('Límite de usuario');
    expect(listAuditEvents).toHaveBeenLastCalledWith({
      limit: 100,
      since: null,
      excludeReads: true,
    });
    expect(screen.getByRole('switch', { name: 'Mostrar lecturas' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('shows access decisions and chat queries with the design labels', async () => {
    const user = userEvent.setup();
    const events: AuditEvent[] = [
      {
        event_id: 'a1'.padEnd(32, '0'),
        ts: iso(1),
        event: 'policy.decision',
        user_id: 'sub-leo',
        actor_email: 'leo@example.com',
        actor_role: 'bu-lead',
        actor_is_admin: true,
        resource: { type: 'Mango::Platform', id: 'mango' },
        hash: 'd'.repeat(64),
        detail: {
          action: 'ViewAudit',
          resource: 'Mango::Platform::mango',
          allowed: true,
          read_only: true,
        },
      },
      {
        event_id: 'a2'.padEnd(32, '0'),
        ts: iso(2),
        event: 'policy.decision',
        user_id: 'sub-eva',
        actor_email: 'eva@example.com',
        actor_role: 'bu-lead',
        actor_is_admin: false,
        resource: { type: 'Mango::Platform', id: 'mango' },
        hash: 'e'.repeat(64),
        detail: {
          action: 'ViewAudit',
          resource: 'Mango::Platform::mango',
          allowed: false,
          read_only: true,
        },
      },
      {
        event_id: 'a3'.padEnd(32, '0'),
        ts: iso(3),
        event: 'agent.completed',
        user_id: 'sub-eva',
        actor_email: 'eva@example.com',
        actor_role: 'bu-lead',
        actor_is_admin: false,
        resource: { type: 'conversation', id: 'conv-9' },
        hash: 'f'.repeat(64),
        detail: {
          agent: 'finops',
          conversation_id: 'conv-9',
          turn: 'turn-1',
          tools: ['cost_explorer', 'budgets'],
          cost_usd: '0.04',
          version: 3,
          model: 'us.anthropic.claude-sonnet-4-6-v1:0',
          authz: { action: 'UseAgent', allowed: true },
        },
      },
      {
        // The turn's start: shown inside the chat query, not as its own row.
        event_id: 'a5'.padEnd(32, '0'),
        ts: iso(4),
        event: 'agent.invoke',
        user_id: 'sub-eva',
        actor_email: 'eva@example.com',
        actor_role: 'bu-lead',
        actor_is_admin: false,
        resource: { type: 'conversation', id: 'conv-9' },
        hash: '2'.repeat(64),
        detail: { agent: 'finops', conversation_id: 'conv-9', turn: 'turn-1' },
      },
      {
        // The turn's decision: shown inside the chat query, not as its own row.
        event_id: 'a4'.padEnd(32, '0'),
        ts: iso(4),
        event: 'policy.decision',
        user_id: 'sub-eva',
        actor_email: 'eva@example.com',
        actor_role: 'bu-lead',
        actor_is_admin: false,
        resource: { type: 'Mango::Agent', id: 'finops' },
        hash: '1'.repeat(64),
        detail: {
          action: 'UseAgent',
          resource: 'Mango::Agent::finops',
          allowed: true,
          read_only: false,
          conversation_id: 'conv-9',
          turn: 'turn-1',
        },
      },
    ];
    renderPage({ listAuditEvents: vi.fn(() => page(events)) });
    const view = (await screen.findByText('Acceso de lectura')).closest('button') as HTMLElement;
    expect(view.querySelector('.au-role')).toHaveTextContent('Admin');
    expect(view.querySelector('.au-actor')?.getAttribute('title')).toContain(
      'Líder de área · Admin',
    );
    expect(within(view).getByText('Ver auditoría · permitido')).toBeInTheDocument();
    const denied = screen.getByText('Acceso denegado').closest('button') as HTMLElement;
    expect(within(denied).getByText('Ver auditoría · denegado (403)')).toBeInTheDocument();
    expect(denied.querySelector('.tk-dot')).toHaveStyle({ background: 'var(--red)' });
    // The actor of a chat query is the user who asked; the agent is the resource.
    const chat = screen.getByText('Consulta del agente').closest('button') as HTMLElement;
    expect(chat.querySelector('.au-name')).toHaveTextContent('eva@example.com');
    expect(within(chat).getByText('finops')).toBeInTheDocument();
    expect(
      within(chat).getByText('Preguntó a finops · 2 llamadas a tools · costo USD 0,04'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Usar agente · permitido')).toBeNull();
    expect(screen.queryByText('Inicio de turno del agente')).toBeNull();
    expect(screen.getByText('3 eventos')).toBeInTheDocument();
    await user.click(chat);
    const drawer = screen.getByRole('dialog');
    // Design: the version of the agent and the model that answered the turn.
    expect(within(drawer).getByText('Versión del agente').parentElement).toHaveTextContent('v3');
    expect(within(drawer).getByText('Modelo').parentElement).toHaveTextContent(
      'us.anthropic.claude-sonnet-4-6-v1:0',
    );
    const start = within(drawer).getByRole('heading', { name: 'Inicio del turno' });
    const startSection = start.closest('section') as HTMLElement;
    expect(within(startSection).getByText('turn-1')).toBeInTheDocument();
    expect(
      within(startSection).getByText(`${'a5'.padEnd(32, '0')} · agent.invoke`),
    ).toBeInTheDocument();
    const authz = within(drawer).getByRole('heading', { name: 'Autorización' });
    const section = authz.closest('section') as HTMLElement;
    expect(within(section).getByText('Usar agente')).toBeInTheDocument();
    expect(within(section).getByText('UseAgent')).toBeInTheDocument();
    expect(within(section).getByText('Permitido')).toHaveClass('au-allowed');
    expect(
      within(section).getByText(`${'a4'.padEnd(32, '0')} · policy.decision`),
    ).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Cerrar' }));
    await user.click(denied);
    const deniedDrawer = screen.getByRole('dialog');
    expect(within(deniedDrawer).getByText(/· Ver auditoría/).parentElement).toHaveTextContent(
      'ViewAudit · Ver auditoría',
    );
    expect(within(deniedDrawer).queryByRole('heading', { name: 'Autorización' })).toBeNull();
    await user.click(within(deniedDrawer).getByRole('button', { name: 'Cerrar' }));
    const cats = screen.getByRole('group', { name: 'Categoría' });
    await user.click(within(cats).getByRole('button', { name: /Chat/ }));
    expect(screen.getByText('1 evento')).toBeInTheDocument();
  });

  it('labels the publication and Brains events, and the groups permission', async () => {
    const base = { user_id: 'sub-ana', actor_email: 'ana@example.com', hash: 'a'.repeat(64) };
    const events: AuditEvent[] = [
      ['agent.provisioner.started', { agent: 'k3fq7zr2m5xw6n4a', version: 2 }],
      [
        'agent.version.failed',
        { agent: 'k3fq7zr2m5xw6n4a', version: 2, failed_step: 'publication_expired' },
      ],
      ['agent.version.retried', { agent: 'k3fq7zr2m5xw6n4a', version: 2 }],
      ['agent.version.reopened', { agent: 'k3fq7zr2m5xw6n4a', version: 2 }],
      ['settings.models.refreshed', { added_count: 0, added: [] }],
      ['settings.models.refreshed', { added_count: 1, added: ['us.amazon.nova-pro-v1:0'] }],
      ['settings.model.price_updated', { model: 'us.amazon.nova-pro-v1:0' }],
      ['agent.deprovision', { agent: 'k3fq7zr2m5xw6n4a', outcome: 'applied' }],
      ['directory.lookup', { emails: 1, ids: 0, emails_found: 1, ids_found: 0 }],
      [
        'policy.decision',
        { action: 'ViewGroups', resource: 'Mango::Platform::mango', allowed: false },
      ],
    ].map(([event, detail], index) => ({
      ...base,
      event_id: `b${String(index)}`.padEnd(32, '0'),
      ts: iso(index + 1),
      event: event as string,
      detail: detail as Record<string, unknown>,
    }));
    renderPage({ listAuditEvents: vi.fn(() => page(events)) });
    for (const label of [
      'Publicación iniciada',
      'Publicación fallida',
      'Publicación reintentada',
      'Reabierto como borrador',
      'Precio de modelo cambiado',
      'Búsqueda en el directorio',
    ]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    // Design (closing round): «Publicación fallida» is red although it reads like «publish».
    const dotOf = (label: string) =>
      screen.getByText(label).closest('.au-ev')?.querySelector<HTMLElement>('.tk-dot');
    expect(dotOf('Publicación fallida')?.style.background).toBe('var(--red)');
    expect(dotOf('Publicación iniciada')?.style.background).toBe('var(--green)');
    expect(screen.getAllByText('Catálogo de Bedrock consultado')).toHaveLength(2);
    expect(
      screen.getByText('Consultó el catálogo de Bedrock · sin modelos nuevos'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Consultó el catálogo de Bedrock · 1 modelo nuevo'),
    ).toBeInTheDocument();
    // Not named by the design: the event name, in the generic format.
    expect(screen.getByText('agent.deprovision')).toBeInTheDocument();
    expect(screen.getByText('Ver grupos · denegado (403)')).toBeInTheDocument();
  });

  it('shows the outcome the API recorded in the row and in the panel (design «Resultado»)', async () => {
    const user = userEvent.setup();
    const write = EVENTS[0] as AuditEvent;
    const events: AuditEvent[] = [
      {
        ...write,
        event_id: 'o1'.padEnd(32, '0'),
        detail: { ...write.detail, outcome: 'requested' },
      },
      {
        ...write,
        event_id: 'o2'.padEnd(32, '0'),
        ts: iso(2),
        detail: { ...write.detail, outcome: 'rejected', error: 'version_conflict' },
      },
      { ...write, event_id: 'o3'.padEnd(32, '0'), ts: iso(3) },
      EVENTS[1] as AuditEvent,
    ];
    renderPage({ listAuditEvents: vi.fn(() => page(events)) });
    const requested = await screen.findByText('· solicitado');
    expect(requested).toHaveClass('au-outcome');
    expect(requested).not.toHaveClass('fail');
    expect(requested.parentElement).toHaveTextContent('Límite propio USD 150,00 · solicitado');
    const failed = screen.getByText('· no se aplicó · version_conflict');
    expect(failed).toHaveClass('au-outcome', 'fail');
    expect(screen.getByText('· aplicado')).toHaveClass('au-outcome');
    // An event without outcome has no suffix.
    const plain = screen.getByText('Cambio de áreas rechazado').closest('button') as HTMLElement;
    expect(plain.querySelector('.au-outcome')).toBeNull();

    await user.click(failed);
    const panel = screen.getByRole('dialog');
    const result = within(panel).getByText('no se aplicó · version_conflict');
    expect(result).toHaveClass('au-outcome', 'fail');
    expect(result.previousElementSibling).toHaveTextContent('Resultado');
    // The panel's sentence is the detail alone; the outcome lives in its row.
    expect(within(panel).getByText('Límite propio USD 150,00')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Cerrar' }));

    await user.click(plain);
    expect(within(screen.getByRole('dialog')).queryByText('Resultado')).toBeNull();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cerrar' }));
    // The outcome is searchable like the rest of the row.
    await user.type(
      screen.getByRole('textbox', { name: 'Buscar en el audit log' }),
      'no se aplicó',
    );
    expect(screen.getByText('1 evento')).toBeInTheDocument();
  });

  it('keeps the decision of a turn that never completed as its own row', async () => {
    const events: AuditEvent[] = [
      {
        event_id: 'b1'.padEnd(32, '0'),
        ts: iso(1),
        event: 'policy.decision',
        user_id: 'sub-eva',
        actor_email: 'eva@example.com',
        actor_role: 'bu-lead',
        actor_is_admin: false,
        resource: { type: 'Mango::Agent', id: 'finops' },
        hash: '2'.repeat(64),
        detail: {
          action: 'UseAgent',
          resource: 'Mango::Agent::finops',
          allowed: true,
          read_only: false,
          conversation_id: 'conv-9',
          turn: 'turn-2',
        },
      },
    ];
    renderPage({ listAuditEvents: vi.fn(() => page(events)) });
    expect(await screen.findByText('Usar agente · permitido')).toBeInTheDocument();
  });

  it('asks the API for the next page with its cursor when everything loaded is shown', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 50 }, (_, index) => ({
      ...(EVENTS[2] as AuditEvent),
      event_id: String(index).padStart(32, '0'),
      ts: iso(index + 1),
    }));
    const older = { ...(EVENTS[2] as AuditEvent), event_id: 'f'.repeat(32), ts: iso(90) };
    const listAuditEvents = vi
      .fn()
      .mockReturnValueOnce(page(many, 'cur1'))
      .mockReturnValueOnce(page([older], null));
    renderPage({ listAuditEvents });
    await user.click(await screen.findByRole('button', { name: 'Mostrar más' }));
    await user.click(screen.getByRole('button', { name: 'Mostrar más' }));
    expect(listAuditEvents).toHaveBeenLastCalledWith({
      limit: 100,
      since: null,
      excludeReads: true,
      cursor: 'cur1',
    });
    expect(await screen.findByText('51 eventos')).toBeInTheDocument();
    // Last page: the server has nothing older.
    expect(screen.queryByRole('button', { name: 'Mostrar más' })).toBeNull();
  });

  it('keeps the loaded events when "Mostrar más" fails, and can try again', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 50 }, (_, index) => ({
      ...(EVENTS[2] as AuditEvent),
      event_id: String(index).padStart(32, '0'),
      ts: iso(index + 1),
    }));
    const listAuditEvents = vi
      .fn()
      .mockReturnValueOnce(page(many, 'cur1'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockReturnValue(page([], null));
    renderPage({ listAuditEvents });
    await user.click(await screen.findByRole('button', { name: 'Mostrar más' }));
    await user.click(screen.getByRole('button', { name: 'Mostrar más' }));
    expect(
      await screen.findByText(
        'No se pudieron cargar más eventos. Los que ya ves siguen aquí; inténtalo de nuevo.',
      ),
    ).toBeInTheDocument();
    // The list stays on screen (no full-page error) and the next attempt reuses the cursor.
    expect(screen.queryByText('No pudimos cargar el audit log')).toBeNull();
    expect(screen.getByText('50 eventos')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mostrar más' }));
    expect(listAuditEvents).toHaveBeenNthCalledWith(2, {
      limit: 100,
      since: null,
      excludeReads: true,
      cursor: 'cur1',
    });
    expect(listAuditEvents).toHaveBeenNthCalledWith(3, {
      limit: 100,
      since: null,
      excludeReads: true,
      cursor: 'cur1',
    });
  });

  it('reports a failed copy when the clipboard API is missing (insecure context)', async () => {
    const user = userEvent.setup();
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    // userEvent.setup() installs a clipboard stub: remove it to simulate plain HTTP.
    Reflect.deleteProperty(navigator, 'clipboard');
    try {
      renderPage({});
      await user.click(await screen.findByText('Límite de usuario'));
      await user.click(screen.getByRole('button', { name: 'Copiar JSON' }));
      expect(await screen.findByText('No se pudo copiar el evento')).toBeInTheDocument();
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
    }
  });

  it('marks "Verificar integridad" as Próximamente and exports the CSV', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    renderPage({});
    await screen.findByText('Límite de usuario');
    expect(screen.queryByRole('button', { name: /Verificar integridad/ })).toBeNull();
    // fireEvent is synchronous: nothing else runs between the click and the next assertion.
    fireEvent.click(screen.getByRole('button', { name: /Exportar CSV/ }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalled();
    // Revoked after the click's tick, so the browser can start the download first.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
    });
    expect(await screen.findByText('3 eventos exportados')).toBeInTheDocument();
    // Design CSV columns, with the event id, the role label and the hash.
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    const [header, first] = (await blob.text()).replace(/^\uFEFF/, '').split('\n');
    expect(header).toBe(
      'id,fecha,actor,rol,evento,accion,recurso,detalle,resultado,antes,despues,hash',
    );
    // The outcome has its own column (design `resultado`), not a suffix of the detail.
    expect(first).toContain('"Límite propio USD 150,00","aplicado",');
    expect(first).toContain(`"${'e1'.padEnd(32, '0')}"`);
    expect(first).toContain('"FinOps central · Admin"');
    expect(first).toContain(`"${'a'.repeat(64)}"`);
    click.mockRestore();
  });

  it('shows a request and its result as one row, and both in the CSV', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const at = Date.now() - 600_000;
    const base = {
      user_id: 'sub-ana',
      actor_email: 'ana@example.com',
      hash: 'a'.repeat(64),
      resource: { type: 'user', id: 'u-4' },
    };
    const events: AuditEvent[] = [
      {
        ...base,
        event_id: 'r2'.padEnd(32, '0'),
        ts: new Date(at + 1000).toISOString(),
        event: 'directory.member_reject',
        detail: { change_id: 'x', outcome: 'applied' },
      },
      {
        ...base,
        event_id: 'r1'.padEnd(32, '0'),
        ts: new Date(at).toISOString(),
        event: 'directory.member_reject',
        detail: { change_id: 'x', outcome: 'requested' },
      },
    ];
    renderPage({ listAuditEvents: vi.fn(() => page(events)) });
    // One row, and an applied rejection reads «registrado».
    const row = (await screen.findByText('Cambio de persona rechazado')).closest('button');
    expect(screen.getAllByText('Cambio de persona rechazado')).toHaveLength(1);
    expect(within(row as HTMLElement).getByText('· registrado')).toBeInTheDocument();
    expect(screen.queryByText('· solicitado')).toBeNull();
    await user.click(row as HTMLElement);
    const panel = screen.getByRole('dialog');
    const requested = within(panel).getByText('Solicitado').nextElementSibling;
    expect(requested).toHaveTextContent('r1'.padEnd(32, '0'));
    expect(requested).toHaveTextContent('se registra antes de aplicar');
    await user.click(within(panel).getByRole('button', { name: 'Cerrar' }));
    fireEvent.click(screen.getByRole('button', { name: /Exportar CSV/ }));
    expect(await screen.findByText('2 eventos exportados')).toBeInTheDocument();
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(await blob.text()).toContain('"solicitado"');
    click.mockRestore();
  });

  it('shows a retry state when the API fails', async () => {
    renderPage({ listAuditEvents: vi.fn(() => Promise.reject(new ApiError(500, 'x', 'x'))) });
    expect(await screen.findByText('No pudimos cargar el audit log')).toBeInTheDocument();
  });

  it('shows the design access state to non-admins without calling the API', () => {
    const listAuditEvents = vi.fn();
    renderPage({ listAuditEvents }, '/audit', false);
    expect(screen.getByText('No tienes acceso a esta sección')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Presupuestos, Ajustes y el Audit log son solo para admins. Un admin de Mango puede darte acceso.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('HTTP 403')).toBeNull();
    expect(listAuditEvents).not.toHaveBeenCalled();
  });

  it('shows the same access state when the API answers 403', async () => {
    renderPage({
      listAuditEvents: vi.fn(() => Promise.reject(new ApiError(403, 'forbidden', 'x'))),
    });
    expect(await screen.findByText('No tienes acceso a esta sección')).toBeInTheDocument();
  });

  it('labels the session events, shortens «FinOps central» and gives the reason of an end', async () => {
    const user = userEvent.setup();
    const base = { user_id: 'sub-eva', actor_role: 'finops-central', actor_is_admin: false };
    const mail = 'eva.finops.central@example.com';
    renderPage({
      listAuditEvents: vi.fn(() =>
        page([
          {
            ...base,
            event_id: 's1'.padEnd(32, '0'),
            ts: iso(1),
            event: 'session.rejected',
            actor_email: mail,
            hash: 'a'.repeat(64),
            detail: { reason: 'sub_mismatch' },
          },
          {
            ...base,
            event_id: 's2'.padEnd(32, '0'),
            ts: iso(2),
            event: 'session.ended',
            hash: 'b'.repeat(64),
            detail: { reason: 'sign_out' },
          },
          {
            ...base,
            event_id: 's3'.padEnd(32, '0'),
            ts: iso(3),
            event: 'session.started',
            actor_email: mail,
            hash: 'c'.repeat(64),
            detail: { federated: false, expires_at: 1 },
          },
        ]),
      ),
    });
    const rejected = (await screen.findByText('Sesión rechazada')).closest('button') as HTMLElement;
    expect(rejected).toHaveTextContent('Intento de renovar con una sesión que ya no sirve');
    expect(rejected.querySelector('.au-outcome.fail')).toHaveTextContent(
      'no se aplicó · sub_mismatch',
    );
    // The start of the email gets the ellipsis; its end is what tells two people apart.
    const actor = within(rejected).getByTitle(`${mail} · FinOps central`);
    expect(actor.querySelector('.au-local')).toHaveTextContent('eva.finops.c');
    expect(actor.querySelector('.au-dom')).toHaveTextContent('entral@example.com');
    expect(actor.querySelector('.au-role')).toHaveTextContent('Central');
    expect(screen.getByText('Sesión iniciada').closest('button')).toHaveTextContent(
      'Ingresó con contraseña y MFA',
    );

    // The label and the sentence of the event read the same.
    await user.click(screen.getAllByText('Sesión cerrada')[0] as HTMLElement);
    const panel = screen.getByRole('dialog', { name: 'Sesión cerrada' });
    expect(within(panel).getByText('Motivo')).toBeInTheDocument();
    expect(within(panel).getByText('La persona cerró sesión')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Cerrar' }));

    await user.click(screen.getByText('Sesión iniciada'));
    const started = screen.getByRole('dialog', { name: 'Sesión iniciada' });
    expect(within(started).queryByText('Motivo')).toBeNull();
    // The email may only break before the «@».
    const email = started.querySelector('.au-mail') as HTMLElement;
    expect(email).toHaveTextContent(mail);
    expect(email.querySelector('wbr')).not.toBeNull();
  });

  it('says what «Mostrar lecturas» adds', async () => {
    renderPage({});
    await screen.findByText('Límite de usuario');
    expect(
      screen.getByTitle(
        'Accesos de solo lectura permitidos y sesiones recuperadas al recargar. Los denegados, los rechazos y los cambios se ven siempre.',
      ),
    ).toBeInTheDocument();
  });
});
