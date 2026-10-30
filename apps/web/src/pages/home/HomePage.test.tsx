import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { HomePage } from './HomePage';
import type { Home } from './model';

const XSS = '<img src=x onerror=alert(1)>';
const adminMe = { ...baseMe, is_admin: true, name: 'Ana', groups: ['mango-admin'] };

function days(count: number, offset: number, turns: number) {
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(today - (offset + count - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    spent_usd: (turns * 0.5).toFixed(6),
    turns,
  }));
}

function home(overrides: Partial<Home> = {}): Home {
  const period = overrides.period ?? '30d';
  const count = Number(period.replace('d', ''));
  return {
    scope: 'org',
    area: null,
    period,
    counted_since: '2026-06-01',
    days: days(count, 0, 2),
    previous: days(count, count, 1),
    approvals: 3,
    budgets_scope: 'agents',
    budgets: [
      { scope: 'agent', id: 'finops', name: null, spent_usd: '170.00', limit_usd: '200.00' },
      {
        scope: 'agent',
        id: 'abcdefghijklmnop',
        name: XSS,
        spent_usd: '210.00',
        limit_usd: '200.00',
      },
    ],
    ...overrides,
  };
}

function renderPage(call: ReturnType<typeof vi.fn>, me: typeof baseMe = adminMe) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders session={sessionValue({ api, me })} path="/dashboard">
      <Routes>
        <Route path="dashboard" element={<HomePage />} />
        <Route path="approvals/*" element={<p>approvals page</p>} />
        <Route path="budgets" element={<p>budgets page</p>} />
      </Routes>
    </TestProviders>,
  );
}

/** The card under a heading, to look inside it. */
async function card(name: string | RegExp) {
  const section = (await screen.findByRole('heading', { name })).closest('section');
  if (!section) throw new Error(`no card for ${String(name)}`);
  return within(section);
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('HomePage', () => {
  it('shows spend and invocations of the period, compared with the one before', async () => {
    const call = vi.fn(() => Promise.resolve(home()));
    renderPage(call);
    expect(call).toHaveBeenCalledWith('getHome', { query: { period: '30d' } }, expect.anything());
    const spend = await card(/Gasto en Bedrock/);
    // 30 days of 1 USD against 30 of 0,50.
    expect(spend.getByText('USD 30,00')).toBeInTheDocument();
    expect(spend.getByText('+100%')).toBeInTheDocument();
    expect(spend.getByText('USD 15,00 periodo anterior')).toBeInTheDocument();
    expect((await card(/Invocaciones/)).getByText('60')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Gasto en Bedrock' })).toBeInTheDocument();
  });

  it('greets the person and leads to the approvals that wait for them', async () => {
    const user = userEvent.setup();
    renderPage(vi.fn(() => Promise.resolve(home())));
    expect(await screen.findByRole('heading', { level: 1, name: /, Ana$/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Responder 3 aprobaciones' }));
    expect(screen.getByText('approvals page')).toBeInTheDocument();
  });

  it('has no notice without approvals', async () => {
    renderPage(vi.fn(() => Promise.resolve(home({ approvals: 0 }))));
    await screen.findByRole('heading', { name: /Gasto en Bedrock/ });
    expect(screen.queryByRole('button', { name: /Responder/ })).not.toBeInTheDocument();
  });

  it('lists the budgets closest to their limit as text, never as markup', async () => {
    renderPage(vi.fn(() => Promise.resolve(home())));
    const scoped = await card('Presupuestos cerca del límite');
    expect(scoped.getByText('FinOps')).toBeInTheDocument();
    expect(scoped.getByText('85%')).toBeInTheDocument();
    expect(scoped.getByText(XSS)).toBeInTheDocument();
    expect(scoped.getByText('105%')).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(scoped.getByRole('button', { name: 'Ver presupuestos' })).toBeInTheDocument();
  });

  it('keeps agent health, tickets and latency as «Próximamente», without data', async () => {
    renderPage(vi.fn(() => Promise.resolve(home())));
    await screen.findByRole('heading', { name: /Gasto en Bedrock/ });
    for (const title of ['Estado de agentes', 'Tickets resueltos', 'Latencia p95']) {
      expect(screen.getByText(`${title}, próximamente`)).toBeInTheDocument();
    }
  });

  it('asks again for another period and remembers it', async () => {
    const user = userEvent.setup();
    const call = vi.fn((_id: string, input: { query: { period: Home['period'] } }) =>
      Promise.resolve(home({ period: input.query.period })),
    );
    renderPage(call);
    await screen.findByRole('heading', { name: /Gasto en Bedrock/ });
    await user.click(screen.getByRole('button', { name: /^Periodo/ }));
    await user.click(screen.getByRole('option', { name: 'Últimos 7 días' }));
    expect(call).toHaveBeenLastCalledWith(
      'getHome',
      { query: { period: '7d' } },
      expect.anything(),
    );
    expect(localStorage.getItem('mango-dash-period')).toBe('7d');
  });

  it('hides the comparison and brings it back', async () => {
    const user = userEvent.setup();
    renderPage(vi.fn(() => Promise.resolve(home())));
    await screen.findByText('USD 15,00 periodo anterior');
    await user.click(screen.getByRole('button', { name: 'Quitar Comparar' }));
    expect(screen.queryByText('USD 15,00 periodo anterior')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ Comparar' }));
    expect(screen.getByText('USD 15,00 periodo anterior')).toBeInTheDocument();
  });

  it('exports a card to CSV', async () => {
    const user = userEvent.setup();
    const create = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', { ...URL, createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    renderPage(vi.fn(() => Promise.resolve(home())));
    await user.click(await screen.findByRole('button', { name: 'Exportar Invocaciones' }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Exportado a CSV')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('offers to retry when the summary cannot be read', async () => {
    const user = userEvent.setup();
    const call = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'home_unavailable', 'please try again'))
      .mockResolvedValue(home());
    renderPage(call);
    expect(await screen.findByText('No se pudo cargar Inicio')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('heading', { name: /Gasto en Bedrock/ })).toBeInTheDocument();
  });

  it('central FinOps sees the organization; a lead or a person, «Próximamente»', async () => {
    const call = vi.fn(() => Promise.resolve(home()));
    renderPage(call, baseMe);
    expect(await screen.findByRole('heading', { name: /Gasto en Bedrock/ })).toBeInTheDocument();
    vi.clearAllMocks();
  });

  it.each([
    {
      ...baseMe,
      role: 'bu-lead' as const,
      business_unit: 'security',
      groups: ['bu-lead', 'bu-security'],
    },
    { ...baseMe, role: null, groups: ['hr'] },
  ])('does not ask the API for an account that is not drawn yet', async (me) => {
    const call = vi.fn(() => Promise.resolve(home()));
    renderPage(call, me);
    expect(
      await screen.findByText('Esta sección todavía no está disponible en Mango.'),
    ).toBeVisible();
    expect(call).not.toHaveBeenCalled();
  });
});
