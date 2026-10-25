import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { ActivityPage } from './ActivityPage';
import type { ActivityEvent, ActivityPage as Page } from './model';

const NOW = Date.parse('2026-10-24T12:30:00Z');
const XSS = '<img src=x onerror=alert(1)>';
const adminMe = { ...baseMe, is_admin: true, groups: ['mango-admin', 'finops-central'] };
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const TASK = 'a'.repeat(32);
const RUN = 'b'.repeat(32);

function event(overrides: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: `e${String(Math.random()).slice(2)}`,
    kind: 'tool',
    agent_id: 'finops',
    at: iso(-5),
    tool: 'get_cost_and_usage',
    ms: 420,
    ok: true,
    approval_id: null,
    approval_status: null,
    mine: true,
    conversation_id: 'c'.repeat(26),
    task_id: null,
    run_id: null,
    task_name: null,
    ...overrides,
  };
}

function page(overrides: Partial<Page> = {}): Page {
  return {
    scope: 'mine',
    events: [
      event({ id: 'own-chat', at: iso(-5), ms: 400 }),
      event({
        id: 'own-task',
        at: iso(-8),
        ms: 200,
        conversation_id: null,
        task_id: TASK,
        run_id: RUN,
        task_name: 'Revisión diaria',
      }),
      event({ id: 'own-error', kind: 'error', at: iso(-9), ms: 900, ok: false }),
      event({
        id: 'approval-1',
        kind: 'approval',
        at: iso(-10),
        tool: 'create_budget',
        ms: null,
        ok: null,
        approval_id: 'f'.repeat(32),
        approval_status: 'pending',
        conversation_id: null,
      }),
      event({
        id: 'blocked',
        kind: 'budget',
        at: iso(-12),
        tool: null,
        ms: null,
        ok: null,
        conversation_id: null,
      }),
    ],
    truncated: false,
    agents: [
      { id: 'finops', name: 'FinOps', icon: 'Money', color: 0, published: true },
      { id: 'security', name: 'Security', icon: 'Shield', color: 2, published: true },
    ],
    retention_days: 30,
    ...overrides,
  };
}

/** What GET /api/activity answers an administrator: someone else's turn without its links. */
const everyone = (): Page =>
  page({
    scope: 'all',
    events: [
      event({ id: 'other', agent_id: 'finops', mine: false, conversation_id: null, at: iso(-3) }),
      ...page().events,
    ],
  });

function renderPage(call: ReturnType<typeof vi.fn>, me = baseMe) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders session={sessionValue({ api, me })} path="/activity">
      <Routes>
        <Route path="activity" element={<ActivityPage />} />
        <Route path="c/:conversationId" element={<p>chat</p>} />
        <Route path="schedules/*" element={<p>schedules</p>} />
        <Route path="approvals/*" element={<p>approvals</p>} />
        <Route path="budgets" element={<p>budgets</p>} />
        <Route path="audit" element={<p>audit</p>} />
      </Routes>
    </TestProviders>,
  );
}

const answering = (data: Page) => vi.fn(() => Promise.resolve(data));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ActivityPage', () => {
  it('shows one person their own activity with the KPIs of the period', async () => {
    const call = answering(page());
    renderPage(call);
    expect(await screen.findByText('Revisión diaria', { exact: false })).toBeInTheDocument();
    expect(call).toHaveBeenCalledWith(
      'getActivity',
      { query: { range: '24h' } },
      expect.anything(),
    );
    expect(
      screen.getByText(
        'Llamadas a tools, aprobaciones pedidas, errores y turnos bloqueados por presupuesto en tus conversaciones y tus tareas.',
      ),
    ).toBeInTheDocument();
    // Five events, three calls, one failed; latency over the measured calls.
    expect(screen.getByText('Eventos · 24 h')).toBeInTheDocument();
    expect(screen.getByText('3 llamadas a tools')).toBeInTheDocument();
    expect(screen.getByText('En tus conversaciones y tareas')).toBeInTheDocument();
    expect(screen.getByText('33,3%')).toBeInTheDocument();
    expect(screen.getByText('1 de 3')).toBeInTheDocument();
    expect(screen.getByText('500 ms')).toBeInTheDocument();
    // The texts of «Disponible hoy».
    expect(screen.getByText('Tarea · Revisión diaria')).toBeInTheDocument();
    expect(screen.getAllByText(/llamó a/).length).toBeGreaterThan(0);
    expect(screen.getByText(/falló al llamar a/)).toBeInTheDocument();
    expect(screen.getByText(/pidió aprobación para/)).toBeInTheDocument();
    expect(screen.getByText(/no respondió: se agotó el presupuesto/)).toBeInTheDocument();
    // Not an administrator: no agents without activity.
    expect(screen.queryByText('sin actividad en el periodo')).not.toBeInTheDocument();
    expect(screen.queryByText(/publicados/)).not.toBeInTheDocument();
  });

  it('opens the own conversation and run, never those of someone else', async () => {
    const user = userEvent.setup();
    renderPage(answering(everyone()), adminMe);
    expect(await screen.findByText(/chats y las tareas de todos/)).toBeInTheDocument();
    expect(screen.getByText('de 2 publicados')).toBeInTheDocument();
    expect(screen.getByText('sin actividad en el periodo')).toBeInTheDocument();
    const rows = document.querySelectorAll<HTMLButtonElement>('.ac-main');
    // The newest row is someone else's: only «Solo FinOps» and the note.
    const first = rows[0];
    if (!first) throw new Error('rows are drawn');
    await user.click(first);
    expect(
      screen.getByText('De otra persona: solo ves el agente, la tool y la hora.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Abrir conversación/ })).not.toBeInTheDocument();
    const own = rows[1];
    if (!own) throw new Error('rows are drawn');
    await user.click(own);
    await user.click(screen.getByRole('button', { name: /Abrir conversación/ }));
    expect(screen.getByText('chat')).toBeInTheDocument();
  });

  it('links the run of the own task and the budgets only for who opens them', async () => {
    const user = userEvent.setup();
    renderPage(answering(page()));
    await user.click(await screen.findByText('Tarea · Revisión diaria'));
    await user.click(screen.getByRole('button', { name: /Ver ejecución/ }));
    expect(screen.getByText('schedules')).toBeInTheDocument();
  });

  it('hides «Ver presupuestos» from who cannot open Presupuestos', async () => {
    const user = userEvent.setup();
    renderPage(answering(page()));
    await user.click(await screen.findByText(/no respondió: se agotó el presupuesto/));
    expect(screen.queryByRole('button', { name: /Ver presupuestos/ })).not.toBeInTheDocument();
  });

  it('filters by kind, agent and text', async () => {
    const user = userEvent.setup();
    renderPage(answering(page()));
    const kinds = await screen.findByRole('group', { name: 'Tipo' });
    expect(within(kinds).getByRole('button', { name: /Todo/ })).toHaveTextContent('5');
    await user.click(within(kinds).getByRole('button', { name: /Errores/ }));
    expect(document.querySelectorAll('.ac-row')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Limpiar' }));
    await user.type(screen.getByLabelText('Buscar actividad'), 'create_budget');
    expect(document.querySelectorAll('.ac-row')).toHaveLength(1);
    await user.clear(screen.getByLabelText('Buscar actividad'));
    await user.type(screen.getByLabelText('Buscar actividad'), 'nada-coincide');
    expect(screen.getByText('Nada coincide con los filtros.')).toBeInTheDocument();
  });

  it('asks the API again for another period', async () => {
    const user = userEvent.setup();
    const call = answering(page());
    renderPage(call);
    await screen.findByText('Tarea · Revisión diaria');
    await user.click(screen.getByRole('button', { name: '7 días' }));
    expect(call).toHaveBeenLastCalledWith(
      'getActivity',
      { query: { range: '7d' } },
      expect.anything(),
    );
    expect(
      await screen.findByText('Aquí se ven hasta 7 días. La actividad se guarda 30 días.'),
    ).toBeInTheDocument();
  });

  it('renders what the API sends as text, never as markup', async () => {
    renderPage(answering(page({ events: [event({ tool: XSS })] })));
    expect(await screen.findByText(XSS)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('polls every 15 s while live and marks what is new', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW });
    const newer = event({ id: 'newer', at: iso(-1), tool: 'get_cost_forecast' });
    const call = vi
      .fn()
      .mockReturnValueOnce(Promise.resolve(page()))
      .mockReturnValue(Promise.resolve(page({ events: [newer, ...page().events] })));
    renderPage(call);
    expect(await screen.findByText('Tarea · Revisión diaria')).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(call).toHaveBeenCalledTimes(2);
    const [, input] = call.mock.calls[1] as [string, { query: { since: string } }];
    expect(Date.parse(input.query.since)).toBe(NOW + 15_000 - 11 * 60_000);
    expect(await screen.findByText('get_cost_forecast')).toBeInTheDocument();
    expect(document.querySelectorAll('.ac-row.is-fresh')).toHaveLength(1);
    // Paused: no more polls.
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByRole('button', { name: /En vivo/ }));
    expect(screen.getByRole('button', { name: /Reanudar/ })).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('shows the skeleton while loading and an error with «Reintentar»', async () => {
    const user = userEvent.setup();
    const call = vi
      .fn()
      .mockReturnValueOnce(Promise.reject(new ApiError(503, 'activity_unavailable', 'x')))
      .mockReturnValueOnce(new Promise(() => {}));
    renderPage(call);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('No se pudo cargar la actividad')).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: /Reintentar/ }));
    expect(screen.getByRole('status', { name: 'Cargando actividad' })).toBeInTheDocument();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('says it is not allowed when the API answers 403', async () => {
    renderPage(vi.fn(() => Promise.reject(new ApiError(403, 'forbidden', 'x'))));
    expect(await screen.findByText(/No tienes acceso|permiso/)).toBeInTheDocument();
  });
});
