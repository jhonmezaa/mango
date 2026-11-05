import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { EvalsPage } from './EvalsPage';
import { suite } from './testFixtures';

const AGENT = {
  id: 'finops',
  status: 'published',
  version: 4,
  lock_version: 1,
  name: 'FinOps',
  description: '',
  category: 'Finanzas',
  icon: 'Money',
  color: 2,
  role: '',
  reports_to: null,
  model: 'mock.model-v1',
  allowed_models: ['mock.model-v1'],
  tools: ['finops.get_cost'],
  unavailable_tools: [],
  published_at: null,
  retired_at: null,
  retire_reason: null,
  is_mine: false,
};
const ADMIN = { ...baseMe, is_admin: true, can: { create_agent: true } };
const CENTRAL = {
  ...baseMe,
  is_admin: false,
  role: 'finops-central' as const,
  can: { create_agent: false },
};

type Handlers = Partial<Record<string, (input: unknown) => Promise<unknown>>>;

function setup(
  suites: unknown[],
  me: typeof ADMIN | typeof CENTRAL = ADMIN,
  handlers: Handlers = {},
) {
  const routes: Handlers = {
    getEvals: () => Promise.resolve({ suites, judge_models: ['mock.model-v1'] }),
    getAgents: () => Promise.resolve({ items: [AGENT] }),
    getModels: () =>
      Promise.resolve({
        version: 1,
        items: [
          {
            id: 'mock.model-v1',
            name: 'Mock',
            provider: 'x',
            supports_tools: true,
            context_tokens: null,
            input_usd: '3',
            output_usd: '15',
          },
        ],
      }),
    getEvalSuite: () => Promise.resolve({ ...suite(), cases: [] }),
    getEvalRuns: () => Promise.resolve({ runs: [] }),
    postEvalEstimate: () => Promise.resolve({ usd: '0.640368', model: 'mock.model-v1' }),
    ...handlers,
  };
  const call = vi.fn((id: string, input?: unknown) => {
    const route = routes[id];
    return route ? route(input) : Promise.reject(new ApiError(404, 'not_found', id));
  });
  render(
    <TestProviders
      session={sessionValue({ api: { call } as unknown as ApiClient, me })}
      path="/evals"
    >
      <Routes>
        <Route path="evals/*" element={<EvalsPage />} />
      </Routes>
    </TestProviders>,
  );
  const calls = (id: string) => call.mock.calls.filter(([name]) => name === id);
  return { calls, user: userEvent.setup() };
}

const rowOf = (name: string) => screen.getByText(name).closest('.ev-tr') as HTMLElement;

describe('EvalsPage (design evals.jsx, D110, D111)', () => {
  it('lists the suites with their state, and runs one on the published version', async () => {
    const { calls, user } = setup([
      suite({
        name: 'Golden',
        last_run: {
          run_id: 'd'.repeat(32),
          score: 90,
          passed: true,
          content_hash: 'a'.repeat(64),
          finished_at: '2026-11-05T12:00:00Z',
        },
        recent_scores: [80, 90],
        completed_runs: 2,
      }),
      suite({
        suite_id: 'e'.repeat(32),
        name: 'Sin presupuesto',
        required: false,
        last_attempt: {
          run_id: 'f'.repeat(32),
          status: 'stopped',
          stop_reason: 'budget',
          cases_done: 1,
          case_count: 3,
          finished_at: '2026-11-05T12:00:00Z',
        },
      }),
    ]);
    expect(await screen.findByRole('heading', { level: 1, name: 'Evals' })).toBeInTheDocument();
    expect(rowOf('Golden')).toHaveTextContent('90%');
    expect(rowOf('Golden')).toHaveTextContent('+10');
    expect(rowOf('Sin presupuesto')).toHaveTextContent('Detenida por presupuesto');
    expect(screen.queryByText(/Solo lectura/)).toBeNull();
    await user.click(within(rowOf('Golden')).getByRole('button', { name: 'Ejecutar Golden' }));
    expect(calls('postEvalRun')[0]?.[1]).toEqual({
      path: { suite_id: 'b'.repeat(32) },
      body: { version: 4 },
    });
  });

  it('is read only for FinOps central: no «Nueva suite», no run, the notice', async () => {
    setup([suite({ name: 'Golden', can_edit: false })], CENTRAL);
    expect(
      await screen.findByText(
        'Solo lectura: crea, ajusta y ejecuta una suite quien edita su agente.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Nueva suite/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ejecutar Golden' })).toBeNull();
    expect(screen.getByText('Agentes sin evals')).toBeInTheDocument();
  });

  it('shows the progress of a run in flight', async () => {
    setup([
      suite({
        name: 'Golden',
        active_run: {
          run_id: 'f'.repeat(32),
          status: 'running',
          version: 4,
          cases_done: 2,
          case_count: 5,
        },
      }),
    ]);
    expect(await screen.findByText('Caso 2 de 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ejecutar Golden' })).toBeDisabled();
  });

  it('says who sees Evals when the API answers 403, and offers the empty state', async () => {
    setup([], ADMIN, {
      getEvals: () => Promise.reject(new ApiError(403, 'forbidden', 'not allowed')),
    });
    expect(await screen.findByText('No tienes acceso a Evals')).toBeInTheDocument();
  });

  it('shows the empty state with «Nueva suite» for whoever edits an agent', async () => {
    setup([]);
    expect(await screen.findByText('Todavía no hay suites')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Nueva suite/ }).length).toBeGreaterThan(0);
  });

  it('opens the detail with the verdicts and the server estimate, never an answer', async () => {
    const { user } = setup([suite({ name: 'Golden', case_count: 1 })], ADMIN, {
      getEvalSuite: () =>
        Promise.resolve({
          ...suite({ name: 'Golden', case_count: 1 }),
          cases: [
            { question: '¿Gasto de EC2?', expected: '', criterion: 'contains', value: 'EC2' },
          ],
        }),
      getEvalRuns: () =>
        Promise.resolve({
          runs: [
            {
              run_id: 'd'.repeat(32),
              version: 4,
              content_hash: 'a'.repeat(64),
              status: 'failed',
              trigger: 'manual',
              launched_by_email: null,
              started_at: '2026-11-05T12:00:00Z',
              finished_at: '2026-11-05T12:01:00Z',
              score: 0,
              threshold: 80,
              stop_reason: null,
              cases: [{ status: 'fail', reason: 'missing_text' }],
            },
          ],
        }),
    });
    await user.click(await screen.findByText('Golden'));
    const panel = await screen.findByRole('dialog', { name: 'Golden' });
    expect(await within(panel).findByText('No cumple: falta «EC2»')).toBeInTheDocument();
    expect(await within(panel).findByText(/≈ USD/)).toBeInTheDocument();
  });
});
