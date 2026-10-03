import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { Agent, MineItem } from '../../components/marketplace/model';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { MarketplacePage } from './MarketplacePage';

function agent(overrides: Partial<Agent> & { id: string; name: string }): Agent {
  return {
    status: 'published',
    version: 2,
    lock_version: null,
    description: '',
    category: 'Finanzas',
    icon: 'Money',
    color: 2,
    role: '',
    reports_to: 'platform',
    model: 'mock.model-v1',
    allowed_models: ['mock.model-v1'],
    tools: [],
    unavailable_tools: [],
    published_at: '2026-09-01T00:00:00Z',
    retired_at: null,
    retire_reason: null,
    is_mine: false,
    cleanup: null,
    ...overrides,
  };
}

const FINOPS = agent({
  id: 'finops',
  name: 'FinOps',
  description: 'Analiza el gasto de AWS de tu organización.',
  role: 'Analista FinOps',
  tools: ['cost-explorer.get_cost_and_usage', 'cost-explorer.get_cost_forecast'],
});
const SAVINGS = agent({
  id: 'k3fq7zr2m5xw6n4a',
  name: 'Savings <b>Plans</b>',
  description: 'Revisa la cobertura. <script>alert(1)</script><img src=x onerror=alert(1)>',
  role: 'Especialista <i>en compromisos</i>',
  reports_to: 'finops',
});
// The one agent the creator of these tests made (`is_mine`).
const TAGS = agent({
  id: 'p2ys6ke4c7dq3hzo',
  name: 'Etiquetado',
  category: 'Operación',
  is_mine: true,
});
const REPORTS = agent({
  id: 'h5cu4n6sl2we7ygt',
  name: 'Reportes mensuales',
  status: 'retired',
  retired_at: '2026-09-20T00:00:00Z',
  retire_reason: 'Lo reemplaza FinOps. <i>Sin uso</i> desde agosto.',
});
const AGENTS = [TAGS, FINOPS, REPORTS, SAVINGS];

const MINE: MineItem[] = [
  {
    agent_id: 'd7vm3a5txo2r6ifb',
    version: 1,
    status: 'draft',
    revision: 1,
    base_version: null,
    name: 'Resumen <u>semanal</u>',
    description: '',
    category: '',
    icon: 'Bot',
    color: 0,
    created_at: '2026-09-29T10:00:00Z',
    updated_at: '2026-09-29T10:00:00Z',
    submitted_at: null,
    rejected_at: '2026-09-29T12:00:00Z',
    rejection_reason: 'Falta el rol. <script>alert(2)</script>',
    failed_step: null,
  },
  {
    agent_id: 'k3fq7zr2m5xw6n4a',
    version: 3,
    status: 'in_review',
    revision: 2,
    base_version: 2,
    name: 'Savings Plans',
    description: '',
    category: 'Finanzas',
    icon: 'Zap',
    color: 4,
    created_at: '2026-09-30T10:00:00Z',
    updated_at: '2026-09-30T10:00:00Z',
    submitted_at: '2026-09-30T10:00:00Z',
    rejected_at: null,
    rejection_reason: null,
    failed_step: null,
  },
];

/** The catalog only creators and admins can read (GET /api/models). */
const MODEL = {
  id: 'mock.model-v1',
  name: 'Mock <b>Model</b> v1',
  provider: 'Mock',
  context_tokens: 200000,
  input_usd: '3.00',
  output_usd: '15.00',
  supports_tools: true,
};

type Handler = (input: { path?: Record<string, unknown>; body?: unknown }) => unknown;

/** `api.call` backed by one handler per operation; an operation without one fails the test. */
function fakeApi(handlers: Record<string, Handler> = {}) {
  const all: Record<string, Handler> = {
    getAgents: () => ({ items: AGENTS }),
    getMine: () => ({
      items: [],
      quotas: { drafts: 0, max_drafts: 20, submissions_today: 0, max_submissions_per_day: 5 },
    }),
    getReviews: () => ({ queue: [], history: [] }),
    getModels: () => ({ version: 1, items: [MODEL] }),
    getBudgets: () => ({
      period: '2026-10',
      version: 1,
      defaults: { user_monthly_usd: '50.00', agent_monthly_usd: '2000.00' },
      agents: [{ agent_id: 'finops', limit_usd: '2000.00', spent_usd: '1700.00' }],
      users: [],
    }),
    ...handlers,
  };
  const call = vi.fn((id: string, input: Parameters<Handler>[0] = {}) => {
    const handler = all[id];
    if (!handler) return Promise.reject(new Error(`unexpected operation ${id}`));
    try {
      return Promise.resolve(handler(input));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('failed'));
    }
  });
  return { call, api: { call } as unknown as ApiClient };
}

function CurrentPath() {
  const { pathname, search } = useLocation();
  return (
    <output data-testid="path">
      {pathname}
      {search}
    </output>
  );
}

type Account = 'admin' | 'creator' | 'user';

function renderPage(api: ApiClient, account: Account = 'admin') {
  return render(
    <TestProviders
      session={sessionValue({
        api,
        me: {
          ...baseMe,
          is_admin: account === 'admin',
          can: { create_agent: account !== 'user' },
        },
      })}
      path="/marketplace"
    >
      <MarketplacePage />
      <CurrentPath />
    </TestProviders>,
  );
}

const cardNames = () =>
  [...document.querySelectorAll('.mk-card .mk-name')].map((node) => node.textContent);
const operations = (call: ReturnType<typeof fakeApi>['call']) => call.mock.calls.map(([id]) => id);

// Nothing pinned, unless a test says otherwise: pinned agents get a group of their own on top.
beforeEach(() => {
  window.localStorage.setItem('mango-pinned-agents', '[]');
});
afterEach(() => {
  window.localStorage.clear();
});

describe('MarketplacePage', () => {
  it('shows only the agents the API returns, grouped by category', async () => {
    const { api, call } = fakeApi({ getAgents: () => ({ items: [FINOPS, TAGS] }) });
    renderPage(api, 'user');
    expect(await screen.findByRole('heading', { level: 1, name: 'Agentes' })).toBeInTheDocument();
    expect(
      await screen.findByText('2 disponibles para ti · según tus grupos de acceso'),
    ).toBeVisible();
    expect(cardNames()).toEqual(['FinOps', 'Etiquetado']);
    expect(screen.getByRole('heading', { level: 2, name: /^finanzas/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /^operación/ })).toBeInTheDocument();
    // An account that neither creates nor administers asks for nothing else and sees no
    // management controls. The API authorizes anyway.
    expect(operations(call)).toEqual(['getAgents']);
    expect(screen.queryByRole('link', { name: /Nuevo agente/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Más opciones de/ })).toBeNull();
    expect(screen.queryByText(/tus agentes en curso/)).toBeNull();
  });

  it('shows the model by identifier, and by name only to creators and admins', async () => {
    // Neither creator nor admin: the catalog is not asked for and the identifier is shown.
    const plain = fakeApi();
    const first = renderPage(plain.api, 'user');
    await screen.findByText('FinOps');
    expect(operations(plain.call)).not.toContain('getModels');
    const ids = screen.getAllByText('mock.model-v1');
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toHaveClass('mono');
    expect(screen.queryByText(MODEL.name)).toBeNull();
    first.unmount();

    const creator = fakeApi();
    const second = renderPage(creator.api, 'creator');
    await screen.findByText('FinOps');
    expect(operations(creator.call)).toContain('getModels');
    expect(screen.getAllByText(MODEL.name).length).toBeGreaterThan(0);
    expect(screen.queryByText('mock.model-v1')).toBeNull();
    second.unmount();

    // A catalog that does not answer, or does not list the model, leaves the identifier.
    const failing = fakeApi({
      getModels: () => {
        throw new Error('down');
      },
    });
    renderPage(failing.api, 'admin');
    await screen.findByText('FinOps');
    expect(screen.getAllByText('mock.model-v1')[0]).toHaveClass('mono');
  });

  it('renders the texts written by creators as text', async () => {
    const { api } = fakeApi({ getMine: () => ({ items: MINE, quotas: {} }) });
    const user = userEvent.setup();
    const { container } = renderPage(api);
    expect(await screen.findByText('Savings <b>Plans</b>')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Revisa la cobertura. <script>alert(1)</script><img src=x onerror=alert(1)>',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Resumen <u>semanal<\/u>/)).toBeInTheDocument();
    expect(screen.getByText(/“Falta el rol\. <script>alert\(2\)<\/script>”/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Ver detalle de Savings <b>Plans</b>' }));
    const panel = screen.getByRole('dialog', { name: 'Savings <b>Plans</b>' });
    expect(within(panel).getByText('Especialista <i>en compromisos</i>')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Cerrar' }));
    await user.click(screen.getByRole('tab', { name: /Retirados/ }));
    await user.click(screen.getByRole('button', { name: 'Ver detalle de Reportes mensuales' }));
    expect(
      screen.getByText(
        'Retirado · Lo reemplaza FinOps. <i>Sin uso</i> desde agosto. · conversaciones, versiones y auditoría se conservan.',
      ),
    ).toBeInTheDocument();
    for (const root of [container, document.body]) {
      expect(root.querySelector('script, img, b, i, u')).toBeNull();
    }
  });

  it('separates active and retired agents in tabs', async () => {
    const { api } = fakeApi();
    const user = userEvent.setup();
    renderPage(api);
    const retiredTab = await screen.findByRole('tab', { name: /^Retirados\s*1$/ });
    expect(cardNames()).toEqual(['FinOps', 'Savings <b>Plans</b>', 'Etiquetado']);

    await user.click(retiredTab);
    expect(retiredTab).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByText('1 retirados · con historial conservado · según tus grupos de acceso'),
    ).toBeVisible();
    expect(cardNames()).toEqual(['Reportes mensuales']);
    const card = screen.getByRole('button', { name: 'Ver detalle de Reportes mensuales' });
    // A retired agent cannot open a chat and has no menu.
    expect(within(card).getByText('Retirado')).toBeInTheDocument();
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('says so when there are no retired agents', async () => {
    const { api } = fakeApi({ getAgents: () => ({ items: [FINOPS] }) });
    const user = userEvent.setup();
    renderPage(api);
    const tab = await screen.findByRole('tab', { name: 'Retirados' });
    await user.click(tab);
    expect(screen.getByText('No hay agentes retirados')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Limpiar filtros' })).toBeNull();
  });

  it('filters by search and category, and clears the filters', async () => {
    const { api } = fakeApi();
    const user = userEvent.setup();
    renderPage(api);
    const search = await screen.findByRole('searchbox', { name: 'Buscar agentes' });
    const category = screen.getByRole('combobox', { name: 'Categoría' });
    expect(within(category).getByRole('option', { name: 'Finanzas · 2' })).toBeInTheDocument();

    await user.selectOptions(category, 'Operación');
    expect(cardNames()).toEqual(['Etiquetado']);

    await user.type(search, 'gasto');
    // Counts follow the search; the category still filters.
    expect(within(category).getByRole('option', { name: 'Operación · 0' })).toBeInTheDocument();
    expect(screen.getByText('Ningún agente coincide')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    expect(search).toHaveValue('');
    expect(cardNames()).toHaveLength(3);
  });

  it('switches to the list layout and sorts by spend for admins', async () => {
    const { api } = fakeApi({
      getBudgets: () => ({
        period: '2026-10',
        version: 1,
        defaults: { user_monthly_usd: '50.00', agent_monthly_usd: '2000.00' },
        agents: [{ agent_id: TAGS.id, name: null, limit_usd: '100.00', spent_usd: '85.00' }],
        users: [],
      }),
    });
    const user = userEvent.setup();
    renderPage(api);
    await user.click(await screen.findByRole('button', { name: 'Lista' }));
    expect(screen.getByRole('button', { name: 'Lista' })).toHaveAttribute('aria-pressed', 'true');
    // A UI preference of this browser (design `mango-mk-layout`).
    expect(window.localStorage.getItem('mango-mk-layout')).toBe('list');
    const rows = () =>
      [...document.querySelectorAll('.mk-tr:not(.mk-th) .mk-name')].map((node) => node.textContent);
    expect(rows()).toEqual(['Etiquetado', 'FinOps', 'Savings <b>Plans</b>']);
    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText('USD 85,00')).toBeInTheDocument();

    const sort = screen.getByRole('combobox', { name: 'Ordenar' });
    expect(
      within(sort).getByRole('option', { name: 'Ordenar: Más usados · Próximamente' }),
    ).toBeDisabled();
    await user.selectOptions(sort, 'spend');
    expect(rows()[0]).toBe('Etiquetado');
  });

  it('opens in the layout that was used last, and in cards for anything else stored', async () => {
    window.localStorage.setItem('mango-mk-layout', 'list');
    const first = renderPage(fakeApi().api);
    expect(await screen.findByRole('button', { name: 'Lista' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    first.unmount();
    window.localStorage.setItem('mango-mk-layout', 'grid<script>');
    renderPage(fakeApi().api);
    expect(await screen.findByRole('button', { name: 'Tarjetas' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it.each([
    ['draft_saved', 'Borrador guardado'],
    ['submitted', 'Enviado a aprobación · lo revisará otro administrador'],
  ])('shows what the Agent Builder did (%s), once', async (builderNotice, text) => {
    render(
      <TestProviders
        session={sessionValue({ api: fakeApi().api, me: baseMe })}
        path={{ pathname: '/marketplace', state: { builderNotice } }}
      >
        <MarketplacePage />
      </TestProviders>,
    );
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getAllByText(text)).toHaveLength(1);
  });

  it('ignores a notice it does not know', async () => {
    render(
      <TestProviders
        session={sessionValue({ api: fakeApi().api, me: baseMe })}
        path={{ pathname: '/marketplace', state: { builderNotice: '<b>x</b>' } }}
      >
        <MarketplacePage />
      </TestProviders>,
    );
    await screen.findByRole('button', { name: 'Tarjetas' });
    expect(document.querySelector('.g-toast-item')).toBeNull();
  });

  it('keeps what has no backend as "Próximamente"', async () => {
    const { api } = fakeApi();
    const user = userEvent.setup();
    renderPage(api, 'user');
    await screen.findByRole('searchbox', { name: 'Buscar agentes' });
    expect(screen.getByText('Estado, próximamente')).toHaveClass('sr-only');
    expect(screen.getByText('Más, próximamente')).toHaveClass('sr-only');
    // Without budgets (not an admin) «Mayor gasto» can be chosen and orders by name.
    const sort = screen.getByRole('combobox', { name: 'Ordenar' });
    await user.selectOptions(sort, 'spend');
    expect(sort).toHaveValue('spend');
    expect(cardNames()).toEqual(['Etiquetado', 'FinOps', 'Savings <b>Plans</b>']);
    const other = screen.getByRole('button', { name: 'Ver detalle de Etiquetado' });
    await user.click(other);
    const panel = screen.getByRole('dialog', { name: 'Etiquetado' });
    expect(within(panel).getByText('Compartir, próximamente')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Editar/ })).toBeNull();
    // Who an agent is shared with changes in the Builder: the detail says so, with no data row.
    expect(panel).not.toHaveTextContent('Compartido con');
    expect(panel).toHaveTextContent(
      'Cambiar con quién se comparte es una versión nueva del agente: se edita en el Builder y pasa por revisión.',
    );
  });

  it('opens the detail with model, tools and organization, and the chat of FinOps', async () => {
    const { api } = fakeApi();
    const user = userEvent.setup();
    renderPage(api);
    await user.click(await screen.findByRole('button', { name: 'Ver detalle de FinOps' }));
    const panel = screen.getByRole('dialog', { name: 'FinOps' });
    // An admin reads the catalog: the model goes by its name (text, never markup).
    const main = within(panel).getByText('Mock <b>Model</b> v1');
    expect(main).not.toHaveClass('mono');
    expect(main.closest('.badge')).toHaveTextContent('Mock <b>Model</b> v1 · principal');
    expect(panel.querySelector('.mk-sec b')).toBeNull();
    expect(within(panel).getByRole('heading', { name: 'herramientas · 1' })).toBeInTheDocument();
    expect(within(panel).getByText('cost-explorer')).toBeInTheDocument();
    expect(within(panel).getByText('get_cost_and_usage')).toHaveClass('mc-tool-chip');
    expect(within(panel).getByText('get_cost_forecast')).toHaveClass('mc-tool-chip');
    expect(within(panel).queryByText('No disponibles')).toBeNull();
    expect(within(panel).getByText('Platform Admin')).toBeInTheDocument();
    expect(within(panel).getByText('Analista FinOps')).toBeInTheDocument();
    expect(within(panel).getByText('USD 1.700,00 de USD 2.000,00')).toBeInTheDocument();
    expect(within(panel).getByText('85%')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Abrir chat' }));
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/\?agent=finops$/);
  });

  it('opens a chat with any agent the user can use', async () => {
    const { api } = fakeApi();
    const user = userEvent.setup();
    renderPage(api, 'user');
    const card = await screen.findByRole('button', { name: 'Ver detalle de Etiquetado' });
    await user.click(within(card).getByRole('button', { name: /Abrir chat/ }));
    // The card itself did not open: the click is the button's.
    expect(screen.queryByRole('dialog', { name: 'Etiquetado' })).toBeNull();
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/\?agent=p2ys6ke4c7dq3hzo$/);
  });

  it('pins and unpins an agent, shows the pinned ones on top and remembers them', async () => {
    window.localStorage.removeItem('mango-pinned-agents');
    const { api } = fakeApi();
    const user = userEvent.setup();
    renderPage(api, 'user');
    await screen.findByRole('button', { name: 'Ver detalle de Etiquetado' });
    const groups = () =>
      [...document.querySelectorAll('.mk-group-h')].map((node) => node.textContent);
    // The release agent is pinned until the user says otherwise.
    expect(groups()[0]).toBe('fijados 1');

    const pin = screen.getByRole('button', { name: 'Fijar Etiquetado' });
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    await user.click(pin);
    expect(screen.queryByRole('dialog', { name: 'Etiquetado' })).toBeNull();
    expect(groups()[0]).toBe('fijados 2');
    // A pinned agent is not repeated in its category group.
    expect(screen.getAllByRole('button', { name: 'Ver detalle de Etiquetado' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Ver detalle de FinOps' })).toHaveLength(1);
    expect(JSON.parse(window.localStorage.getItem('mango-pinned-agents') ?? '')).toEqual([
      'finops',
      'p2ys6ke4c7dq3hzo',
    ]);

    // From the detail panel.
    await user.click(screen.getByRole('button', { name: 'Ver detalle de FinOps' }));
    const panel = screen.getByRole('dialog', { name: 'FinOps' });
    const pinned = within(panel).getByRole('button', { name: 'Fijado' });
    expect(pinned).toHaveAttribute('aria-pressed', 'true');
    await user.click(pinned);
    expect(within(panel).getByRole('button', { name: 'Fijar' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(groups()[0]).toBe('fijados 1');
    // Unpinned, it is back in its category group, once.
    expect(screen.getAllByRole('button', { name: 'Ver detalle de FinOps' })).toHaveLength(1);
    expect(window.localStorage.getItem('mango-pinned-agents')).toBe('["p2ys6ke4c7dq3hzo"]');
  });

  it('offers neither chat nor pin for a retired agent', async () => {
    const { api } = fakeApi();
    const user = userEvent.setup();
    renderPage(api, 'user');
    await user.click(await screen.findByRole('tab', { name: /Retirados/ }));
    const card = screen.getByRole('button', { name: 'Ver detalle de Reportes mensuales' });
    expect(within(card).queryByRole('button', { name: /Abrir chat/ })).toBeNull();
    expect(within(card).queryByRole('button', { name: /Fijar/ })).toBeNull();
  });

  it('names the supervisor agent, or leaves it out when the user cannot see it', async () => {
    const hidden = agent({
      id: 'w4nx2g7ajr5ue6ms',
      name: 'Pronósticos',
      reports_to: 'zzzzzzzzzzzzzzzz',
    });
    const { api } = fakeApi({ getAgents: () => ({ items: [FINOPS, SAVINGS, hidden] }) });
    const user = userEvent.setup();
    renderPage(api, 'user');
    await user.click(
      await screen.findByRole('button', { name: 'Ver detalle de Savings <b>Plans</b>' }),
    );
    const reportsTo = (name: string) =>
      within(screen.getByRole('dialog', { name })).getByText('Reporta a').nextElementSibling;
    expect(reportsTo('Savings <b>Plans</b>')).toHaveTextContent(/^FinOps$/);
    await user.click(screen.getByRole('button', { name: 'Cerrar' }));
    await user.click(screen.getByRole('button', { name: 'Ver detalle de Pronósticos' }));
    expect(reportsTo('Pronósticos')).toHaveTextContent(/^—$/);
    expect(document.body).not.toHaveTextContent('zzzzzzzzzzzzzzzz');
  });

  it('lists the own versions in progress and the reviews waiting for an admin', async () => {
    const { api } = fakeApi({
      getMine: () => ({ items: MINE, quotas: {} }),
      getReviews: () => ({
        queue: [{ is_author: false }, { is_author: true }, { is_author: false }],
        history: [],
      }),
    });
    const user = userEvent.setup();
    renderPage(api);
    const heading = await screen.findByRole('heading', { name: /tus agentes en curso/ });
    const section = heading.closest('section') as HTMLElement;
    expect(heading).toHaveTextContent('tus agentes en curso 2');
    expect(
      within(section).getByRole('link', { name: '2 cambios esperan tu revisión →' }),
    ).toHaveAttribute('href', '/review');
    const rejected = within(section).getByRole('link', { name: /Resumen/ });
    expect(rejected).toHaveAttribute('href', '/admin/d7vm3a5txo2r6ifb/1');
    expect(rejected).toHaveTextContent('Rechazado');
    expect(rejected).toHaveTextContent('Corregir');
    const change = within(section).getByRole('link', { name: /Savings Plans/ });
    expect(change).toHaveAttribute('href', '/admin/k3fq7zr2m5xw6n4a/3');
    expect(change).toHaveTextContent('· cambio a publicado');
    expect(change).toHaveTextContent('En revisión');

    // The section belongs to the unfiltered list of active agents.
    await user.type(screen.getByRole('searchbox', { name: 'Buscar agentes' }), 'fin');
    expect(screen.queryByRole('heading', { name: /tus agentes en curso/ })).toBeNull();
  });

  it('still shows the agents when the optional requests fail', async () => {
    const fail = () => {
      throw new ApiError(503, 'unavailable', 'down');
    };
    const { api } = fakeApi({ getMine: fail, getReviews: fail, getBudgets: fail });
    renderPage(api);
    expect(await screen.findByRole('button', { name: 'Ver detalle de FinOps' })).toBeVisible();
    expect(screen.queryByText(/tus agentes en curso/)).toBeNull();
    expect(screen.getByRole('link', { name: /Nuevo agente/ })).toHaveAttribute('href', '/admin');
  });

  it('shows an error with retry when the agents cannot be loaded', async () => {
    let attempts = 0;
    const { api } = fakeApi({
      getAgents: () => {
        attempts += 1;
        if (attempts === 1) throw new ApiError(500, 'internal_error', 'boom');
        return { items: [FINOPS] };
      },
    });
    const user = userEvent.setup();
    renderPage(api, 'user');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No se pudieron cargar los agentes');
    expect(alert).toHaveTextContent('No se pudo completar la acción. Inténtalo de nuevo.');
    expect(alert).not.toHaveTextContent('boom');
    // Design: the bar stays, only the body says what happened.
    expect(screen.getByRole('tab', { name: 'Activos' })).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Ver detalle de FinOps' })).toBeVisible();
  });

  it('requires a reason to retire and sends the lock of the detail', async () => {
    const retired = { ...TAGS, status: 'retired', lock_version: 5, retire_reason: 'Sin uso' };
    const { api, call } = fakeApi({
      getAgent: () => ({ ...TAGS, lock_version: 4 }),
      retireAgent: () => retired,
    });
    const user = userEvent.setup();
    renderPage(api);
    await user.click(await screen.findByRole('button', { name: 'Más opciones de Etiquetado' }));
    await user.click(screen.getByRole('menuitem', { name: 'Retirar…' }));

    const dialog = screen.getByRole('dialog', { name: 'Retirar “Etiquetado”' });
    expect(dialog).toHaveTextContent('Solo un admin puede retirar agentes.');
    const submit = within(dialog).getByRole('button', { name: 'Retirar' });
    const reason = within(dialog).getByRole('textbox', { name: 'Motivo' });
    expect(reason).toHaveFocus();
    expect(submit).toBeDisabled();
    // The lock is read when the dialog opens, not when it is sent.
    expect(operations(call)).toContain('getAgent');
    await user.type(reason, '   ');
    expect(submit).toBeDisabled();
    expect(operations(call)).not.toContain('retireAgent');

    await user.clear(reason);
    await user.type(reason, '  Sin uso  ');
    await user.click(submit);
    expect(
      await screen.findByText('"Etiquetado" retirado · el historial se conserva'),
    ).toBeVisible();
    expect(call).toHaveBeenCalledWith('getAgent', { path: { agent_id: TAGS.id } });
    expect(call).toHaveBeenCalledWith('retireAgent', {
      path: { agent_id: TAGS.id },
      body: { lock_version: 4, reason: 'Sin uso' },
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cardNames()).toEqual(['FinOps', 'Savings <b>Plans</b>']);
    expect(screen.getByRole('tab', { name: /^Retirados\s*2$/ })).toBeInTheDocument();
  });

  it('keeps the dialog open with a message when the retirement is refused', async () => {
    let failure = new ApiError(409, 'version_conflict', 'changed');
    const { api } = fakeApi({
      getAgent: () => ({ ...TAGS, lock_version: 4 }),
      retireAgent: () => {
        throw failure;
      },
    });
    const user = userEvent.setup();
    renderPage(api);
    await user.click(await screen.findByRole('button', { name: 'Más opciones de Etiquetado' }));
    await user.click(screen.getByRole('menuitem', { name: 'Retirar…' }));
    const dialog = screen.getByRole('dialog', { name: 'Retirar “Etiquetado”' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Motivo' }), 'Sin uso');
    await user.click(within(dialog).getByRole('button', { name: 'Retirar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'El agente cambió o ya no está publicado.',
    );

    failure = new ApiError(403, 'forbidden', 'internal detail');
    await user.click(within(dialog).getByRole('button', { name: 'Retirar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).not.toHaveTextContent('internal detail');
    expect(alert).not.toHaveTextContent('El agente cambió');
    expect(cardNames()).toContain('Etiquetado');
  });

  it('only offers «Retirar» to admins, and «Compartir» to nobody yet', async () => {
    const { api } = fakeApi();
    const user = userEvent.setup();
    renderPage(api, 'creator');
    await user.click(await screen.findByRole('button', { name: 'Más opciones de Etiquetado' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Editar' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Compartir…/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(menu).queryByRole('menuitem', { name: 'Retirar…' })).toBeNull();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Más opciones de Etiquetado' })).toHaveFocus();
    // The menu never opens the detail of its card.
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Más opciones de Etiquetado' }));
    await user.click(screen.getByRole('menuitem', { name: 'Editar' }));
    // Always with the version: a creator without `UseAgent` cannot open `/admin/<id>`.
    expect(screen.getByTestId('path')).toHaveTextContent(
      `/admin/${TAGS.id}/${String(TAGS.version)}`,
    );
  });

  it('offers «Editar» and «Duplicar» only to admins and to whoever created the agent', async () => {
    const menus = () =>
      screen
        .queryAllByRole('button', { name: /^Más opciones de / })
        .map((node) => node.ariaLabel)
        .sort();
    const user = userEvent.setup();

    // A creator: only on the agent they created, in the card and in the detail.
    const creator = renderPage(fakeApi().api, 'creator');
    await screen.findByRole('button', { name: 'Ver detalle de FinOps' });
    expect(menus()).toEqual(['Más opciones de Etiquetado']);
    await user.click(screen.getByRole('button', { name: 'Ver detalle de FinOps' }));
    const theirs = screen.getByRole('dialog', { name: 'FinOps' });
    expect(within(theirs).queryByRole('button', { name: /Editar/ })).toBeNull();
    await user.click(within(theirs).getByRole('button', { name: 'Cerrar' }));
    await user.click(screen.getByRole('button', { name: 'Ver detalle de Etiquetado' }));
    expect(
      within(screen.getByRole('dialog', { name: 'Etiquetado' })).getByRole('button', {
        name: /Editar/,
      }),
    ).toBeInTheDocument();
    creator.unmount();

    // Someone who cannot create agents: on none, even if the API said the agent is theirs.
    const plain = renderPage(fakeApi().api, 'user');
    await screen.findByRole('button', { name: 'Ver detalle de FinOps' });
    expect(menus()).toEqual([]);
    plain.unmount();

    // An admin: on every active agent.
    renderPage(fakeApi().api, 'admin');
    await screen.findByRole('button', { name: 'Ver detalle de FinOps' });
    expect(menus()).toEqual([
      'Más opciones de Etiquetado',
      'Más opciones de FinOps',
      'Más opciones de Savings <b>Plans</b>',
    ]);
  });

  it('shows the month spend only for agents that spent something, and always for FinOps', async () => {
    const { api } = fakeApi({
      getBudgets: () => ({
        period: '2026-10',
        version: 1,
        defaults: { user_monthly_usd: '50.00', agent_monthly_usd: '2000.00' },
        agents: [
          { agent_id: 'finops', name: null, limit_usd: '2000.00', spent_usd: '0.00' },
          { agent_id: TAGS.id, name: null, limit_usd: '100.00', spent_usd: '0.00' },
          { agent_id: SAVINGS.id, name: null, limit_usd: '100.00', spent_usd: '25.00' },
        ],
        users: [],
      }),
    });
    renderPage(api);
    const card = async (name: string) =>
      await screen.findByRole('button', { name: `Ver detalle de ${name}` });
    expect((await card('FinOps')).querySelector('.mk-budget')).toHaveTextContent('0%');
    expect((await card('Etiquetado')).querySelector('.mk-budget')).toBeNull();
    expect((await card('Savings <b>Plans</b>')).querySelector('.mk-budget')).toHaveTextContent(
      '25%',
    );
  });

  it('shows the capabilities of the release agent only', async () => {
    renderPage(fakeApi().api, 'user');
    const finops = await screen.findByRole('button', { name: 'Ver detalle de FinOps' });
    expect(within(finops).getByRole('list', { name: 'Capacidades del agente' })).toHaveTextContent(
      'Costos y usoÁreas y OUsPronósticos+2',
    );
    const other = screen.getByRole('button', { name: 'Ver detalle de Etiquetado' });
    expect(within(other).queryByRole('list')).toBeNull();
  });

  it('marks the tools of a disabled MCP as not available in the detail', async () => {
    const lost = {
      ...FINOPS,
      tools: [...FINOPS.tools, 'aws-pricing.get_products'],
      unavailable_tools: ['aws-pricing.get_products'],
    };
    const user = userEvent.setup();
    renderPage(fakeApi({ getAgents: () => ({ items: [lost] }) }).api, 'user');
    await user.click(await screen.findByRole('button', { name: 'Ver detalle de FinOps' }));
    const panel = screen.getByRole('dialog', { name: 'FinOps' });
    expect(within(panel).getByRole('heading', { name: 'herramientas · 2' })).toBeInTheDocument();
    const badge = within(panel).getByText('No disponibles');
    expect(badge.closest('.mk-line')).toHaveTextContent('aws-pricing');
    expect(badge.closest('.mk-line')).not.toHaveTextContent('cost-explorer');
  });

  it('tells admins how the removal of a retired agent goes, and reads again until it ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cleaning = { ...REPORTS, cleanup: 'running' as const };
    const failed = { ...REPORTS, cleanup: 'failed' as const };
    let reads = 0;
    const { api } = fakeApi({
      getAgents: () => {
        reads += 1;
        return { items: [FINOPS, reads === 1 ? cleaning : failed] };
      },
    });
    const user = userEvent.setup();
    renderPage(api);
    await user.click(await screen.findByRole('tab', { name: /Retirados/ }));
    const card = screen.getByRole('button', { name: 'Ver detalle de Reportes mensuales' });
    expect(card).toHaveTextContent('LimpiandoRetirado');
    await user.click(card);
    const panel = screen.getByRole('dialog', { name: 'Reportes mensuales' });
    expect(within(panel).getByRole('status')).toHaveTextContent(
      'Borrando su infraestructura en segundo plano. Tarda unos minutos.',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(reads).toBe(2);
    expect(card).toHaveTextContent('Limpieza fallóRetirado');
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'La limpieza de recursos falló. Quedó infraestructura sin borrar; quien opera la instalación debe revisarla. El historial no se ve afectado.',
    );
    // Nothing is being removed any more: the page stops asking.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(reads).toBe(2);
    vi.useRealTimers();
  });

  it('says nothing about the infrastructure when the API does not (finished, or not an admin)', async () => {
    const user = userEvent.setup();
    renderPage(fakeApi({ getAgents: () => ({ items: [{ ...REPORTS, cleanup: 'done' }] }) }).api);
    await user.click(await screen.findByRole('tab', { name: /Retirados/ }));
    const card = screen.getByRole('button', { name: 'Ver detalle de Reportes mensuales' });
    expect(card).not.toHaveTextContent('Limpi');
    await user.click(card);
    const panel = screen.getByRole('dialog', { name: 'Reportes mensuales' });
    expect(panel).toHaveTextContent('Retirado · Lo reemplaza FinOps.');
    expect(within(panel).queryByRole('status')).toBeNull();
    expect(within(panel).queryByRole('alert')).toBeNull();
  });

  it('keeps the tabs and filters while the agents load', async () => {
    let release: (value: unknown) => void = () => undefined;
    const { api } = fakeApi({
      getAgents: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    renderPage(api, 'user');
    expect((await screen.findByText('Cargando agentes…')).closest('[role="status"]')).toHaveClass(
      'mk-empty',
    );
    expect(screen.getByRole('tab', { name: 'Activos' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Buscar agentes' })).toBeInTheDocument();
    await act(async () => {
      release({ items: [FINOPS] });
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Ver detalle de FinOps' })).toBeVisible();
  });

  it('duplicates an agent as a new draft and opens it in the Agent Builder', async () => {
    const definition = {
      name: 'Un nombre de agente que ya ocupa cuarenta',
      description: 'd',
      category: 'Operación',
      icon: 'Search',
      color: 6,
      reports_to: 'platform',
      role: 'Auditor',
      model: 'mock.model-v1',
      allowed_models: ['mock.model-v1'],
      system_prompt: 'You find untagged spend.',
      tools: ['cost-explorer.get_cost_and_usage'],
      approval_tools: [],
      limits: {
        max_tokens: 4096,
        max_iterations: 8,
        timeout_seconds: 120,
        max_tokens_per_call: null,
        temperature: null,
      },
      groups: ['finops-central'],
      users: [],
    };
    const { api, call } = fakeApi({
      readVersion: () => ({ definition }),
      postAgent: () => ({ agent_id: 'n6ro3b2kq7yd5wsa', version: 1 }),
    });
    const user = userEvent.setup();
    renderPage(api, 'creator');
    await user.click(await screen.findByRole('button', { name: 'Más opciones de Etiquetado' }));
    await user.click(screen.getByRole('menuitem', { name: 'Duplicar' }));
    await vi.waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/admin/n6ro3b2kq7yd5wsa/1');
    });
    expect(call).toHaveBeenCalledWith('readVersion', {
      path: { agent_id: TAGS.id, version: TAGS.version },
    });
    expect(call).toHaveBeenCalledWith('postAgent', {
      body: { definition: { ...definition, name: 'Un nombre de agente que ya ocupa (copia)' } },
    });
    // Design: no toast here; the Agent Builder says where the draft comes from.
    expect(document.querySelector('.g-toasts')).toBeEmptyDOMElement();
  });

  it('explains a refused copy without leaving the page', async () => {
    const { api } = fakeApi({
      readVersion: () => {
        throw new ApiError(403, 'forbidden', 'internal detail');
      },
    });
    const user = userEvent.setup();
    renderPage(api, 'creator');
    await user.click(await screen.findByRole('button', { name: 'Más opciones de Etiquetado' }));
    await user.click(screen.getByRole('menuitem', { name: 'Duplicar' }));
    const toast = document.querySelector('.g-toasts') as HTMLElement;
    await vi.waitFor(() => {
      expect(toast).not.toBeEmptyDOMElement();
    });
    expect(toast).not.toHaveTextContent('internal detail');
    expect(screen.getByTestId('path')).toHaveTextContent('/marketplace');
  });
});
