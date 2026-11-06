import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { readPreference, removePreference } from '../../preferences/storage';
import { agentFixture, baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import type { Ticket, TicketDetail } from './model';
import { ME, OTHER, THIRD, detail, person, ticket } from './testFixtures';
import { TicketsPage } from './TicketsPage';

const XSS = '<img src=x onerror=alert(1)>';
const retired = agentFixture({ id: 'reportes', name: 'Reportes', status: 'retired' });

type Answer = unknown;
type Answers = Record<string, unknown>;

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderPage(answers: Answers, path = '/tickets', overrides = {}) {
  const call = vi.fn((operation: string, input?: unknown) => {
    const found = answers[operation];
    const answer = typeof found === 'function' ? (found as (i: unknown) => Answer)(input) : found;
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${operation}`));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders
      session={sessionValue({ api, agents: [agentFixture(), retired], ...overrides })}
      path={path}
    >
      <Routes>
        <Route path="tickets/*" element={<TicketsPage />} />
        <Route path="approvals/*" element={<Where />} />
      </Routes>
      <Where />
    </TestProviders>,
  );
  return { call, user: userEvent.setup() };
}

const list = (items: Ticket[]) => ({
  items,
  counts: { all: items.length, mine: 0, unassigned: 0, high: 0 },
});

afterEach(() => {
  removePreference('mango-tk-view');
  vi.restoreAllMocks();
});

describe('TicketsPage · lista', () => {
  it('shows the board with the short id, the title as text and the counts', async () => {
    const a = ticket({ title: XSS, priority: 'high', assignee: person(ME) });
    const b = ticket({ status: 'needs_approval', agent_id: 'finops', agent_name: 'FinOps' });
    const c = ticket({ status: 'done' });
    renderPage({ listTickets: list([a, b, c]) });
    const card = await screen.findByRole('button', { name: `${a.ticket_id.slice(0, 8)}: ${XSS}` });
    expect(card).toHaveTextContent(XSS);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    const board = (name: string) => screen.getByRole('region', { name });
    expect(within(board('Por aprobar')).getByText('Espera aprobación')).toBeInTheDocument();
    // «Por aprobar» takes no new ticket: no «+».
    expect(
      within(board('Abierto')).getByRole('button', { name: 'Nuevo ticket en Abierto' }),
    ).toBeInTheDocument();
    expect(
      within(board('Por aprobar')).queryByRole('button', { name: /Nuevo ticket en/ }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: /Asignados a mí\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Prioridad alta\s*1/ })).toBeInTheDocument();
    expect(screen.getByText('3 tickets')).toBeInTheDocument();
  });

  it('searches by title or id and clears it', async () => {
    const a = ticket({ title: 'Costo de EC2' });
    const b = ticket({ title: 'Otro' });
    const { user } = renderPage({ listTickets: list([a, b]) });
    const search = await screen.findByRole('searchbox', { name: 'Buscar tickets' });
    await user.type(search, b.ticket_id.slice(0, 8));
    expect(screen.getByText('1 ticket')).toBeInTheDocument();
    expect(screen.queryByText('Costo de EC2')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Limpiar' }));
    expect(screen.getByText('Costo de EC2')).toBeInTheDocument();
  });

  it('shows the list, sorts it and keeps the layout as a preference', async () => {
    const { user } = renderPage({
      listTickets: list([ticket({ title: 'Beta' }), ticket({ title: 'Alfa' })]),
    });
    await user.click(await screen.findByRole('button', { name: 'Lista' }));
    expect(readPreference('mango-tk-view')).toBe('list');
    await user.click(screen.getByRole('columnheader', { name: 'título' }));
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Alfa');
    // Nothing matches: the design's empty state.
    await user.type(screen.getByRole('searchbox', { name: 'Buscar tickets' }), 'zzz');
    expect(screen.getByText('Ningún ticket coincide')).toBeInTheDocument();
  });

  it('filters by status from the popover', async () => {
    const { user } = renderPage({
      listTickets: list([ticket({ title: 'Uno' }), ticket({ title: 'Dos', status: 'done' })]),
    });
    await user.click(await screen.findByRole('button', { name: 'Filtros' }));
    const pop = screen.getByRole('dialog', { name: 'Filtros' });
    await user.click(within(pop).getByRole('button', { name: 'Resuelto' }));
    expect(screen.getByText('1 ticket')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Filtros\s*1/ })).toHaveClass('mk-active');
  });

  it('moves a ticket «Por aprobar» only to «Resuelto»', async () => {
    const pending = ticket({ status: 'needs_approval', title: 'Pendiente', version: 3 });
    const { call, user } = renderPage({
      listTickets: list([pending]),
      getTicket: detail({ ...pending, approval_id: 'f'.repeat(32) }),
      changeTicket: detail({ ...pending, status: 'done', version: 4 }),
    });
    await user.click(await screen.findByRole('button', { name: /Pendiente/ }));
    const panel = await screen.findByRole('dialog');
    const status = within(panel).getByRole('combobox', { name: 'Estado' });
    expect(within(status).getByRole('option', { name: 'Abierto' })).toBeDisabled();
    expect(within(status).getByRole('option', { name: 'En curso' })).toBeDisabled();
    expect(within(status).getByRole('option', { name: 'Resuelto' })).toBeEnabled();
    expect(within(panel).getByText('Espera aprobación')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Marcar como resuelto' }));
    expect(call).toHaveBeenCalledWith('changeTicket', {
      path: { ticket_id: pending.ticket_id },
      body: { version: 3, status: 'done' },
    });
    expect(
      await screen.findByText(`${pending.ticket_id.slice(0, 8)} → Resuelto`),
    ).toBeInTheDocument();
  });

  it('says why a change was refused and reads the list again on a conflict', async () => {
    const item = ticket({ title: 'Uno' });
    const { call, user } = renderPage({
      listTickets: list([item]),
      getTicket: detail(item),
      changeTicket: new ApiError(409, 'ticket_changed', 'changed'),
    });
    await user.click(await screen.findByRole('button', { name: /Uno/ }));
    const panel = await screen.findByRole('dialog');
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Prioridad' }), 'high');
    expect(
      await screen.findByText('El ticket cambió mientras lo veías: se volvió a cargar.'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(call.mock.calls.filter(([op]) => op === 'listTickets')).toHaveLength(2);
    });
  });
});

describe('TicketsPage · estados', () => {
  it('shows the empty state with «Nuevo ticket»', async () => {
    renderPage({ listTickets: list([]) });
    expect(await screen.findByText('No hay tickets')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Nuevo ticket' }).length).toBeGreaterThan(0);
  });

  it('retries after an error and says when there is no access', async () => {
    let fail = true;
    const { user } = renderPage({
      listTickets: () => {
        if (fail) {
          fail = false;
          return new ApiError(503, 'tickets_unavailable', 'x');
        }
        return list([ticket({ title: 'Ya está' })]);
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar Tickets.');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Ya está')).toBeInTheDocument();
  });

  it('shows a 429 with the common block and its wait (design round 38)', async () => {
    renderPage({ listTickets: new ApiError(429, 'rate_limited', 'x', 30) });
    expect(await screen.findByText('Demasiadas solicitudes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reintentar en/ })).toBeDisabled();
  });

  it('shows 403 as «No tienes acceso a Tickets»', async () => {
    renderPage({ listTickets: new ApiError(403, 'forbidden', 'x') });
    expect(await screen.findByText('No tienes acceso a Tickets')).toBeInTheDocument();
  });
});

describe('TicketsPage · panel', () => {
  function opened(overrides: Partial<TicketDetail> = {}, more: Answers = {}) {
    const item = detail({ title: 'Costo', ...overrides });
    const view = renderPage(
      { listTickets: list([item]), getTicket: item, ...more },
      `/tickets/${item.ticket_id}`,
    );
    return { item, ...view };
  }

  it('opens the ticket of the URL with its fields', async () => {
    const { item } = opened({
      source: 'agent',
      agent_id: 'finops',
      agent_name: 'FinOps',
      creator: person(OTHER, 'otra@example.com'),
      description: XSS,
    });
    const panel = await screen.findByRole('dialog', {
      name: new RegExp(`^${item.ticket_id.slice(0, 8)}`),
    });
    expect(within(panel).getByRole('heading', { name: 'Costo' })).toBeInTheDocument();
    expect(within(panel).getByText(/otra@example\.com · vía FinOps/)).toBeInTheDocument();
    expect(within(panel).getByText(XSS)).toHaveClass('tk-desc');
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(
      within(panel).getByText('«Por aprobar» lo marca una solicitud de Aprobaciones.'),
    ).toBeInTheDocument();
  });

  it('says «No puedes ver este ticket» on a 404 and for an id that is not one', async () => {
    const { call } = renderPage(
      { listTickets: list([]), getTicket: new ApiError(404, 'not_found', 'x') },
      '/tickets/abcdefgh2345',
    );
    expect(await screen.findByText('No puedes ver este ticket')).toBeInTheDocument();
    expect(call).toHaveBeenCalledWith('getTicket', expect.anything(), expect.anything());
  });

  it('asks nothing for a malformed id', async () => {
    const { call, user } = renderPage({ listTickets: list([]) }, '/tickets/MNG-1');
    expect(await screen.findByText('No puedes ver este ticket')).toBeInTheDocument();
    expect(call.mock.calls.map(([op]) => op)).not.toContain('getTicket');
    await user.click(screen.getByRole('button', { name: 'Volver a Tickets' }));
    expect(screen.getAllByTestId('where')[0]).toHaveTextContent('/tickets');
  });

  it('loads, fails and retries', async () => {
    let fail = true;
    const item = detail({ title: 'Tras reintentar' });
    const { user } = renderPage(
      {
        listTickets: list([item]),
        getTicket: () => {
          if (fail) {
            fail = false;
            return new ApiError(503, 'x', 'x');
          }
          return item;
        },
      },
      `/tickets/${item.ticket_id}`,
    );
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText('No se pudo cargar el ticket.')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Reintentar' }));
    expect(
      await within(panel).findByRole('heading', { name: 'Tras reintentar' }),
    ).toBeInTheDocument();
  });

  it('assigns only to the person or whoever takes part', async () => {
    const { item, call, user } = opened(
      {
        creator: person(OTHER, 'otra@example.com'),
        participants: [person(OTHER, 'otra@example.com'), person(THIRD, 'tercera@example.com')],
        version: 2,
      },
      {},
    );
    call.mockImplementation((op: string) =>
      Promise.resolve(op === 'changeTicket' ? { ...item, assignee: person(ME) } : item),
    );
    const panel = await screen.findByRole('dialog');
    const select = within(panel).getByRole('combobox', { name: 'Asignado' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Sin asignar',
      `${baseMe.email ?? ''} (tú)`,
      'otra@example.com',
      'tercera@example.com',
    ]);
    await user.click(within(panel).getByRole('button', { name: 'Asignarme' }));
    expect(call).toHaveBeenCalledWith('changeTicket', {
      path: { ticket_id: item.ticket_id },
      body: { version: 2, assignee_id: ME },
    });
  });

  it('says the agent can no longer be used, without a link', async () => {
    opened({ agent_id: 'reportes', agent_name: 'Reportes', source: 'agent' });
    const panel = await screen.findByRole('dialog');
    expect(
      within(panel).getByText(
        'Ya no puedes usar Reportes. Ves este ticket porque lo creaste; el agente no se abre desde aquí.',
      ),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole('link', { name: /Reportes/ })).toBeNull();
  });

  it('tells an administrator who lost the agent why they still see the ticket', async () => {
    const item = detail({
      title: 'Costo',
      agent_id: 'reportes',
      agent_name: 'Reportes',
      source: 'agent',
      creator: person(OTHER, 'otra@example.com'),
    });
    renderPage({ listTickets: list([item]), getTicket: item }, `/tickets/${item.ticket_id}`, {
      me: { ...baseMe, is_admin: true },
    });
    const panel = await screen.findByRole('dialog');
    expect(
      await within(panel).findByText(
        'Ya no puedes usar Reportes. Ves este ticket porque eres administrador.',
      ),
    ).toBeInTheDocument();
  });

  it('renders the description of a task result as Markdown, without raw HTML', async () => {
    opened({ source: 'task', description: `## Resumen\n\n**Listo** ${XSS}` });
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByRole('heading', { name: 'Resumen' })).toBeInTheDocument();
    expect(within(panel).getByText('Listo').tagName).toBe('STRONG');
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('keeps the description of a ticket written by hand as plain text', async () => {
    opened({ source: 'web', description: '**no es Markdown**' });
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText('**no es Markdown**')).toHaveClass('tk-desc');
  });

  it('opens the request that keeps it «Por aprobar»', async () => {
    const approval = 'f'.repeat(32);
    const { user } = opened({
      status: 'needs_approval',
      approval_id: approval,
      agent_id: 'finops',
      agent_name: 'FinOps',
      source: 'agent',
    });
    const panel = await screen.findByRole('dialog');
    expect(
      within(panel).getByText(
        'Hay una solicitud abierta en la conversación donde FinOps creó este ticket.',
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        'Mientras la solicitud siga abierta, solo se puede marcar «Resuelto».',
      ),
    ).toBeInTheDocument();
    const status = within(panel).getByRole('combobox', { name: 'Estado' });
    expect(
      within(status)
        .getAllByRole('option')
        .filter((o) => !(o as HTMLOptionElement).disabled)
        .map((o) => o.textContent),
    ).toEqual(['Por aprobar', 'Resuelto']);
    await user.click(within(panel).getByRole('button', { name: 'Revisar en Aprobaciones' }));
    expect(screen.getAllByTestId('where')[0]).toHaveTextContent(`/approvals/pending/${approval}`);
  });

  it('renders comments as Markdown without raw HTML and publishes one', async () => {
    const { item, call, user } = opened({
      comments: [
        {
          comment_id: 'c1',
          author: person(OTHER, 'otra@example.com'),
          body: `**Importante** ${XSS}`,
          created_at: new Date().toISOString(),
        },
      ],
    });
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Importante').tagName).toBe('STRONG');
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(within(panel).getByText(/Menciones que avisan/)).toBeInTheDocument();
    const answered = {
      ...item,
      comments: [
        ...item.comments,
        {
          comment_id: 'c2',
          author: person(ME),
          body: 'Hecho',
          created_at: new Date().toISOString(),
        },
      ],
    };
    call.mockImplementation((op: string) => Promise.resolve(op === 'addComment' ? answered : item));
    const box = within(panel).getByRole('textbox', { name: 'Comentario' });
    await user.type(box, 'Hecho');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(call).toHaveBeenCalledWith('addComment', {
      path: { ticket_id: item.ticket_id },
      body: { body: 'Hecho' },
    });
    expect(
      await screen.findByText(`Comentario publicado en ${item.ticket_id.slice(0, 8)}`),
    ).toBeInTheDocument();
    // The panel shows the comment the API answered, as «Tú».
    expect(within(panel).getByText('Hecho')).toBeInTheDocument();
    expect(within(panel).getByText('Tú')).toBeInTheDocument();
    expect(box).toHaveValue('');
  });

  it('shows the activity and the tools of each kind of ticket', async () => {
    const { user } = opened({ source: 'web' });
    const panel = await screen.findByRole('dialog');
    await user.click(within(panel).getByRole('tab', { name: 'Actividad' }));
    expect(within(panel).getByText('creó el ticket')).toBeInTheDocument();
    await user.click(within(panel).getByRole('tab', { name: 'Herramientas · 0' }));
    expect(
      within(panel).getByText('Lo creó una persona: no hay llamadas de un agente.'),
    ).toBeInTheDocument();
  });

  it('marks the tools of an agent ticket as «Próximamente»', async () => {
    opened({ source: 'agent', agent_id: 'finops', agent_name: 'FinOps' });
    const panel = await screen.findByRole('dialog');
    expect(
      within(panel).getByRole('tab', { name: /Herramientas\s*Próximamente/ }),
    ).toBeInTheDocument();
  });

  it('copies the link with the whole id', async () => {
    const { item, user } = opened();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const panel = await screen.findByRole('dialog');
    await user.click(within(panel).getByRole('button', { name: 'Copiar enlace' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/tickets/${item.ticket_id}`);
    expect(await screen.findByText('Enlace copiado')).toBeInTheDocument();
  });
});

describe('TicketsPage · nuevo ticket', () => {
  it('asks for a title and creates the ticket with an optional agent', async () => {
    const created = detail({ title: 'Nuevo' });
    const { call, user } = renderPage({ listTickets: list([]), createNewTicket: created });
    await user.click(
      (await screen.findAllByRole('button', { name: 'Nuevo ticket' }))[0] as HTMLElement,
    );
    const dialog = screen.getByRole('dialog', { name: 'Nuevo ticket' });
    expect(within(dialog).getByText(/elegirlo aquí no lo pone a trabajar/)).toBeInTheDocument();
    // Only the agents the person may use now; «Por aprobar» is never offered.
    const agent = within(dialog).getByRole('combobox', { name: 'Agente' });
    expect(
      within(agent)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Sin agente', 'FinOps · FinOps']);
    // Design round 38: it starts on «Sin agente».
    expect(agent).toHaveValue('');
    expect(within(dialog).queryByRole('option', { name: 'Por aprobar' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Crear ticket' }));
    expect(within(dialog).getByText('Escribe un título')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: 'Título' }), 'Nuevo');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Asignar a' }), 'me');
    await user.click(within(dialog).getByRole('button', { name: 'Crear ticket' }));
    expect(call).toHaveBeenCalledWith('createNewTicket', {
      body: {
        title: 'Nuevo',
        description: '',
        priority: 'medium',
        status: 'open',
        agent_id: null,
        assign_to_me: true,
      },
    });
    expect(
      await screen.findByText(`Ticket ${created.ticket_id.slice(0, 8)} creado`),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Nuevo ticket' })).toBeNull();
  });

  it('keeps the form and says why when the API refuses it', async () => {
    const { user } = renderPage({
      listTickets: list([]),
      createNewTicket: new ApiError(422, 'secret_in_ticket', 'x'),
    });
    await user.click(
      (await screen.findAllByRole('button', { name: 'Nuevo ticket' }))[0] as HTMLElement,
    );
    const dialog = screen.getByRole('dialog', { name: 'Nuevo ticket' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Título' }), 'AKIA');
    await user.click(within(dialog).getByRole('button', { name: 'Crear ticket' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'El texto parece contener una credencial',
    );
  });
});
