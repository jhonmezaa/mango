import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { GovernancePage } from './GovernancePage';
import type { Governance } from './model';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const XSS = '<img src=x onerror=alert(1)>';
const adminMe = { ...baseMe, is_admin: true, groups: ['mango-admin', 'finops-central'] };
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const POLICY = {
  condition: 'always' as const,
  amount_usd: null,
  count: null,
  environment: null,
  approvers: 1,
  expires_hours: 24 as const,
};

function approvals(overrides: Partial<NonNullable<Governance['approvals']>> = {}) {
  return {
    pending: 3,
    mine: 2,
    mine_soon: 1,
    next_expires_at: iso(45),
    approved_7d: 4,
    rejected_7d: 1,
    policies: [
      {
        tool: 'aws-budgets.create_budget',
        server_name: 'AWS Budgets',
        policy: POLICY,
        pending: 2,
        total: 5,
      },
    ],
    capped: false,
    ...overrides,
  };
}

function full(overrides: Partial<Governance> = {}): Governance {
  return {
    approvals: approvals(),
    budgets: {
      period: '2026-10',
      over_warn: [
        {
          scope: 'agent',
          id: 'finops',
          name: null,
          spent_usd: '170.00',
          limit_usd: '200.00',
          exhausted: false,
        },
        {
          scope: 'user',
          id: 'user-1',
          name: 'lead@example.com',
          spent_usd: '20.00',
          limit_usd: '20.00',
          exhausted: true,
        },
      ],
    },
    areas: { pending: 1 },
    audit: {
      events_24h: 42,
      capped: false,
      recent: [
        {
          event_id: 'e'.repeat(32),
          ts: iso(-10),
          event: 'budget.exceeded',
          user_id: 'user-1',
          actor_email: XSS,
          detail: {},
          hash: 'h',
        },
        {
          event_id: 'f'.repeat(32),
          ts: iso(-30),
          event: 'settings.bu_mapping.approved',
          user_id: 'admin-2',
          actor_email: 'admin2@example.com',
          detail: { change_id: 'c1', base_version: 4, outcome: 'applied' },
          hash: 'h',
        },
      ],
    },
    ...overrides,
  };
}

/** What GET /api/governance answers a central FinOps account that is not an administrator. */
const central = (): Governance => full({ budgets: null, areas: null, audit: null });

function renderPage(call: ReturnType<typeof vi.fn>, me = adminMe) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders session={sessionValue({ api, me })} path="/governance">
      <Routes>
        <Route path="governance" element={<GovernancePage />} />
        <Route path="approvals/*" element={<p>approvals</p>} />
        <Route path="budgets" element={<p>budgets</p>} />
        <Route path="audit" element={<p>audit</p>} />
        <Route path="settings/:tab" element={<p>settings areas</p>} />
      </Routes>
    </TestProviders>,
  );
}

const answering = (data: Governance) => vi.fn(() => Promise.resolve(data));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('GovernancePage', () => {
  it('shows what needs attention, the indicators, the policies and the activity', async () => {
    const call = answering(full());
    renderPage(call);
    expect(await screen.findByText('2 aprobaciones esperan tu firma')).toBeInTheDocument();
    expect(call).toHaveBeenCalledWith('getGovernance', {}, expect.anything());
    expect(screen.getByText('1 vence en menos de 1 h')).toBeInTheDocument();
    expect(screen.getByText('2 presupuestos pasaron el 80 %')).toBeInTheDocument();
    // The release agent by its name and the person by email, as the budgets screen.
    expect(screen.getByText('FinOps 85 % · lead@example.com 100 %')).toBeInTheDocument();
    expect(screen.getByText('1 cambio de áreas pendiente')).toBeInTheDocument();
    // Indicators of «Disponible hoy»: no team spend, no risk, no «encadenado».
    expect(screen.getByText('La primera vence en 45 min')).toBeInTheDocument();
    expect(screen.getByText('4 aprobadas · 1 rechazada')).toBeInTheDocument();
    expect(screen.getByText('Sin lecturas · con hash y Object Lock en S3')).toBeInTheDocument();
    expect(screen.queryByText('Gasto de equipos')).not.toBeInTheDocument();
    expect(screen.queryByText(/riesgo alto/)).not.toBeInTheDocument();
    expect(screen.queryByText(/encadenado/)).not.toBeInTheDocument();
    // One line per tool, with its rule and its requests.
    expect(screen.getByText('aws-budgets.create_budget')).toBeInTheDocument();
    expect(screen.getByText(/5 solicitudes/)).toBeInTheDocument();
    expect(screen.getByText('2 pendientes')).toBeInTheDocument();
    // The activity uses the texts of Auditoría; the blocked turn has the design's.
    expect(screen.getByText('Turno bloqueado por presupuesto')).toBeInTheDocument();
    expect(screen.getByText('Cambio de áreas aprobado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Audit log/ })).toBeInTheDocument();
    expect(screen.getByText(/aprobaciones, presupuestos y acceso/)).toBeInTheDocument();
  });

  it('renders what the API sends as text, never as markup', async () => {
    renderPage(answering(full()));
    expect(await screen.findByText(new RegExp(XSS.replace(/[()]/g, '\\$&')))).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows central FinOps only the approvals, with its own subtitle', async () => {
    renderPage(answering(central()), baseMe);
    expect(await screen.findByText('2 aprobaciones esperan tu firma')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Qué necesita atención y cómo se están resolviendo las aprobaciones. Presupuestos, cambios de áreas y auditoría los ven los administradores.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/presupuestos pasaron/)).not.toBeInTheDocument();
    expect(screen.queryByText(/cambio de áreas pendiente/)).not.toBeInTheDocument();
    expect(screen.queryByText('Eventos auditados · 24 h')).not.toBeInTheDocument();
    expect(screen.queryByText('actividad reciente')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Audit log/ })).not.toBeInTheDocument();
    expect(document.querySelector('.gv-kpis')?.getAttribute('data-n')).toBe('2');
    expect(document.querySelector('.gv-grid')?.classList.contains('is-single')).toBe(true);
  });

  it('says all is in order with the text for what the person sees', async () => {
    const quiet = approvals({
      pending: 0,
      mine: 0,
      mine_soon: 0,
      next_expires_at: null,
      policies: [],
    });
    renderPage(answering({ ...central(), approvals: quiet }), baseMe);
    expect(await screen.findByText('Todo en orden')).toBeInTheDocument();
    expect(screen.getByText('No hay aprobaciones que esperen tu firma.')).toBeInTheDocument();
    expect(screen.getByText('Nada pendiente')).toBeInTheDocument();
    expect(
      screen.getByText('Ninguna tool de escritura tuvo solicitudes en los últimos 7 días.'),
    ).toBeInTheDocument();
  });

  it('says «Más de 5000» past the cap of the count', async () => {
    const { audit } = full();
    if (!audit) throw new Error('the fixture has an audit section');
    renderPage(answering({ ...full(), audit: { ...audit, capped: true, events_24h: 5000 } }));
    expect(await screen.findByText('Más de 5000')).toBeInTheDocument();
  });

  it('names the approved and retired agent and its creator in the activity (round 20)', async () => {
    const audit = full().audit;
    if (!audit) throw new Error('an administrator reads the audit trail');
    const agentEvent = (id: string, event: string, detail: Record<string, unknown>) => ({
      event_id: id.repeat(32),
      ts: iso(-5),
      event,
      user_id: 'admin-2',
      actor_email: 'admin2@example.com',
      detail: {
        agent: 'finops',
        version: 3,
        created_by: 'sub-luis',
        outcome: 'applied',
        ...detail,
      },
      hash: 'h',
      agent: { name: 'FinOps', created_by_email: 'luis@example.com' },
    });
    renderPage(
      answering({
        ...full(),
        audit: {
          ...audit,
          recent: [
            agentEvent('a', 'agent.version.approved', { approved_by: 'admin-2' }),
            agentEvent('b', 'agent.retired', { retired_by: 'admin-2', reason: 'Duplicado' }),
          ],
        },
      }),
    );
    expect(
      await screen.findByText('FinOps · v3 · creado por luis@example.com', { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('FinOps · v3 · motivo: “Duplicado”', { exact: false }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('sub-luis');
  });

  it('opens each screen from its row and indicator', async () => {
    const user = userEvent.setup();
    renderPage(answering(full()));
    await user.click(await screen.findByText('1 cambio de áreas pendiente'));
    expect(screen.getByText('settings areas')).toBeInTheDocument();
  });

  it('shows the skeleton while loading and an error with «Reintentar»', async () => {
    const user = userEvent.setup();
    const call = vi
      .fn()
      .mockReturnValueOnce(Promise.reject(new ApiError(503, 'governance_unavailable', 'x')))
      .mockReturnValueOnce(new Promise(() => {}));
    renderPage(call);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('No se pudo cargar Gobernanza')).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: /Reintentar/ }));
    expect(screen.getByRole('status', { name: 'Cargando gobernanza' })).toBeInTheDocument();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('says it is not allowed when the API answers 403', async () => {
    renderPage(vi.fn(() => Promise.reject(new ApiError(403, 'forbidden', 'x'))));
    // Design round 20: the notice of Gobernanza, not the shared one.
    expect(await screen.findByText('No tienes acceso a Gobernanza')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Gobernanza es para administradores y para FinOps central. Un admin de Mango puede darte acceso.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Gobernanza' })).not.toBeInTheDocument();
  });
});
