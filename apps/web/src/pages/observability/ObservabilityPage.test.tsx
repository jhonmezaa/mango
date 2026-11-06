import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import type { Reading, Trace } from './model';
import { ObservabilityPage } from './ObservabilityPage';

const XSS = '<img src=x onerror=alert(1)>';
const adminMe = { ...baseMe, is_admin: true, groups: ['mango-admin'] };
const ID = 'ab12cd34'.padEnd(32, '0');

function trace(overrides: Partial<Trace> = {}): Trace {
  return {
    id: ID,
    agent_id: 'finops',
    agent_name: 'FinOps',
    agent_version: 3,
    playground: false,
    origin: 'chat',
    user_id: 'user-7',
    user_email: 'persona@empresa.com',
    matched: true,
    started_at: '2026-11-05T14:50:00.000Z',
    duration_ms: 4000,
    status: 'ok',
    model: 'us.anthropic.claude-sonnet-4-6',
    input_tokens: 1000,
    output_tokens: 100,
    cost_usd: '0.004500',
    model_calls: 2,
    tool_calls: 1,
    tools_failed: 0,
    spans: [
      {
        kind: 'model',
        name: 'us.anthropic.claude-sonnet-4-6',
        offset_ms: 0,
        duration_ms: 1000,
        failed: false,
        input_tokens: 600,
        output_tokens: 40,
      },
      {
        kind: 'tool',
        name: 'mango_finops___get_cost_and_usage',
        offset_ms: 1100,
        duration_ms: 2000,
        failed: false,
        input_tokens: null,
        output_tokens: null,
      },
    ],
    more_spans: 0,
    ...overrides,
  };
}

function reading(overrides: Partial<Reading> = {}): Reading {
  const traces = overrides.traces ?? [
    trace(),
    trace({
      id: 'ee'.repeat(16),
      origin: 'task',
      status: 'error',
      tools_failed: 1,
      started_at: '2026-11-05T14:40:00.000Z',
    }),
    trace({
      id: 'ff'.repeat(16),
      matched: false,
      origin: null,
      user_id: null,
      user_email: null,
      cost_usd: null,
      agent_version: null,
      started_at: '2026-11-05T14:30:00.000Z',
    }),
    trace({
      id: '11'.repeat(16),
      playground: true,
      origin: 'playground',
      started_at: '2026-11-05T14:20:00.000Z',
    }),
  ];
  return {
    range: '24h',
    generated_at: '2026-11-05T15:00:00+00:00',
    capped: false,
    unreadable: 0,
    unmatched: 1,
    summary: {
      traces: 4,
      agents: 1,
      p50_ms: 4000,
      p95_ms: 4000,
      failed: 1,
      failed_by_tool: 1,
      error_percent: '25.0',
      cost_usd: '0.013500',
      input_tokens: 4000,
      output_tokens: 400,
    },
    hourly: [{ hour: '2026-11-05T14:00:00.000+00:00', ok: 3, error: 1 }],
    by_agent: [{ agent_id: 'finops', agent_name: 'FinOps', traces: 4, p95_ms: 4000, failed: 1 }],
    tools: [{ name: 'mango_finops___get_cost_and_usage', calls: 4, failed: 1, p95_ms: 2000 }],
    total: traces.length,
    offset: 0,
    traces,
    ...overrides,
  };
}

function renderPage(call: ReturnType<typeof vi.fn>) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders session={sessionValue({ api, me: adminMe })} path="/observability">
      <Routes>
        <Route path="observability" element={<ObservabilityPage />} />
        <Route path="activity" element={<p>activity</p>} />
      </Routes>
    </TestProviders>,
  );
}

const answering = (data: Reading) => vi.fn(() => Promise.resolve(data));

describe('ObservabilityPage', () => {
  it('shows the KPIs of the reading and a row per trace, metadata only', async () => {
    const call = answering(reading());
    renderPage(call);
    expect(await screen.findByText('Conversación de persona@empresa.com')).toBeInTheDocument();
    expect(call).toHaveBeenCalledWith(
      'getObservability',
      { query: { range: '24h', status: 'all', q: '', limit: 40 } },
      expect.anything(),
    );
    expect(screen.getByText('Tarea de persona@empresa.com')).toBeInTheDocument();
    expect(screen.getByText('Sin turno de Mango')).toBeInTheDocument();
    expect(screen.getByText('Prueba en Playground de persona@empresa.com')).toBeInTheDocument();
    expect(screen.getByText('25,0%')).toBeInTheDocument();
    expect(screen.getByText('1 trazas con una tool fallida')).toBeInTheDocument();
    expect(screen.getByText('4 k tokens · sin el guardrail')).toBeInTheDocument();
    expect(screen.getByText('4 s / 4 s')).toBeInTheDocument();
    // A trace without a turn has no cost.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('ab12cd34 · ', { exact: false })).toBeInTheDocument();
    // Design round 38: no «Con aprobación» chip while a turn carries no such mark.
    expect(screen.queryByText('Con aprobación')).toBeNull();
    expect(screen.queryByText(/al menos/)).not.toBeInTheDocument();
  });

  it('opens a trace with its short id and copies the whole id', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage(answering(reading()));
    await user.click(await screen.findByText('Conversación de persona@empresa.com'));
    const drawer = screen.getByRole('dialog', { name: 'Traza ab12cd34' });
    expect(within(drawer).getByText(/^Solo metadatos: tipo de llamada/)).toBeInTheDocument();
    expect(within(drawer).getByText('Modelo · us.anthropic.claude-sonnet-4-6')).toBeInTheDocument();
    expect(within(drawer).getByText('mango_finops___get_cost_and_usage')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Copiar ID' }));
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(await screen.findByText('ID copiado')).toBeInTheDocument();
    await user.click(within(drawer).getByText('Modelo · us.anthropic.claude-sonnet-4-6'));
    expect(within(drawer).getByText('Tokens de entrada', { exact: false })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says under the title that a trace without a Mango turn has no person nor cost', async () => {
    const user = userEvent.setup();
    renderPage(answering(reading()));
    await user.click(await screen.findByText('Sin turno de Mango'));
    expect(
      within(screen.getByRole('dialog')).getByText(
        'Esta traza no tiene un turno de Mango: es anterior a la vista o no la escribió Mango. No hay persona ni costo.',
      ),
    ).toBeInTheDocument();
  });

  it('says a tool failed in the drawer of a failed trace', async () => {
    const user = userEvent.setup();
    renderPage(answering(reading()));
    await user.click(await screen.findByText('Tarea de persona@empresa.com'));
    expect(screen.getByText('Una tool respondió con error.')).toBeInTheDocument();
  });

  it('marks every count as a minimum when the reading reached its cap', async () => {
    renderPage(answering(reading({ capped: true })));
    expect(
      await screen.findByText(
        'La lectura se detuvo en 4 trazas: las cifras son un mínimo. Acorta el rango o elige un agente para verlo completo.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('al menos 4')).toBeInTheDocument();
    expect(screen.getByText('al menos 1 trazas con una tool fallida')).toBeInTheDocument();
  });

  it('sends the search, the filters and the agent to the server', async () => {
    const user = userEvent.setup();
    const call = answering(reading());
    renderPage(call);
    await screen.findByText('Conversación de persona@empresa.com');
    await user.click(screen.getByRole('button', { name: 'Con error' }));
    await user.click(screen.getByRole('button', { name: '6 h' }));
    await user.selectOptions(screen.getByLabelText('Agente'), 'finops');
    await user.type(screen.getByLabelText('Buscar trazas'), 'get_cost');
    await waitFor(() => {
      expect(call).toHaveBeenLastCalledWith(
        'getObservability',
        { query: { range: '6h', status: 'error', q: 'get_cost', agent: 'finops', limit: 40 } },
        expect.anything(),
      );
    });
  });

  it('pages with «Mostrar más» from the server', async () => {
    const user = userEvent.setup();
    const first = reading({ total: 5 });
    const more = reading({ total: 5, offset: 4, traces: [trace({ id: '22'.repeat(16) })] });
    const call = vi.fn((_id: string, input: { query: { offset?: number } }) =>
      Promise.resolve(input.query.offset ? more : first),
    );
    renderPage(call);
    await user.click(await screen.findByRole('button', { name: 'Mostrar más · quedan 1' }));
    expect(call).toHaveBeenLastCalledWith('getObservability', {
      query: { range: '24h', status: 'all', q: '', offset: 4, limit: 40 },
    });
    expect(await screen.findByText('22222222 · ', { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mostrar más/ })).not.toBeInTheDocument();
  });

  it('tells an empty range from a search that found nothing', async () => {
    renderPage(
      answering(
        reading({ traces: [], total: 0, summary: { ...reading().summary, traces: 0, agents: 0 } }),
      ),
    );
    expect(await screen.findByText('No hay trazas en este rango')).toBeInTheDocument();
  });

  it('says «Ninguna traza coincide.» when the filters leave nothing', async () => {
    renderPage(answering(reading({ traces: [], total: 0 })));
    expect(await screen.findByText('Ninguna traza coincide.')).toBeInTheDocument();
  });

  it('renders the names of the spans and the agents as text', async () => {
    const user = userEvent.setup();
    renderPage(
      answering(
        reading({
          traces: [trace({ agent_name: XSS })],
          by_agent: [{ agent_id: 'finops', agent_name: XSS, traces: 1, p95_ms: 1, failed: 0 }],
        }),
      ),
    );
    expect((await screen.findAllByText(XSS)).length).toBeGreaterThan(0);
    await user.click(screen.getByText('Conversación de persona@empresa.com'));
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows who sees it on a 403', async () => {
    renderPage(vi.fn(() => Promise.reject(new ApiError(403, 'forbidden', 'not allowed'))));
    expect(
      await screen.findByText('Observabilidad es solo para administradores de Mango.'),
    ).toBeInTheDocument();
  });

  it('retries after an error', async () => {
    const user = userEvent.setup();
    const call = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'observability_unavailable', 'please try again'))
      .mockResolvedValue(reading());
    renderPage(call);
    expect(await screen.findByText('No se pudo cargar Observabilidad.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Reintentar/ }));
    expect(await screen.findByText('Conversación de persona@empresa.com')).toBeInTheDocument();
  });

  it('waits the Retry-After of a 429 before asking again', async () => {
    renderPage(vi.fn(() => Promise.reject(new ApiError(429, 'rate_limited', 'slow down', 30))));
    expect(await screen.findByText('Demasiadas solicitudes')).toBeInTheDocument();
    expect(
      screen.getByText(
        /^Observabilidad admite 30 lecturas por minuto: cada filtro, búsqueda o página cuenta\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reintentar en/ })).toBeDisabled();
  });
});
