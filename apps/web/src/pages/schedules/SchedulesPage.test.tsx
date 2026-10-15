import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import type { TaskList } from './model';
import { SchedulesPage } from './SchedulesPage';
import { AGENTS, XSS, list, run, task } from './testFixtures';

type Handler = (input: { path?: Record<string, string>; body?: unknown }) => unknown;

function apiWith(handlers: Record<string, Handler>) {
  return vi.fn((operation: string, input: Parameters<Handler>[0] = {}) => {
    const handler = handlers[operation];
    if (!handler) return Promise.reject(new Error(`unexpected ${operation}`));
    const answer = handler(input);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
}

function renderPage(call: ReturnType<typeof vi.fn>, isAdmin = false) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders
      session={sessionValue({ api, me: { ...baseMe, is_admin: isAdmin } })}
      path="/schedules"
    >
      <Routes>
        <Route path="schedules/*" element={<SchedulesPage />} />
        <Route path="approvals/*" element={<p>approvals</p>} />
      </Routes>
    </TestProviders>,
  );
}

const base = (tasks: TaskList) => ({ listTasksOfCaller: () => tasks, getAgents: () => AGENTS });

describe('SchedulesPage', () => {
  it('lists tasks with their frequency, owner and runs (design)', async () => {
    renderPage(apiWith(base(list([task()]))));
    expect(
      await screen.findByText('Budget check diario', { selector: '.mk-name' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Todos los días · 09:30')).toBeInTheDocument();
    expect(screen.getByText('FinOps · como Usuario 1 · Bandeja del creador')).toBeInTheDocument();
    expect(screen.getByLabelText('Últimas ejecuciones')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nuevo schedule' })).toBeInTheDocument();
  });

  it('shows names and tasks as text, never as markup', async () => {
    renderPage(apiWith(base(list([task({ name: XSS, task: XSS })]))));
    expect(await screen.findByText(XSS, { selector: '.mk-name' })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('hides creating for whoever may not create', async () => {
    renderPage(apiWith(base(list([], { can_create: false }))));
    expect(await screen.findByText('Ningún schedule coincide.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuevo schedule' })).toBeNull();
  });

  it('runs a task now and tells it is queued', async () => {
    const call = apiWith({
      ...base(list([task()])),
      runTaskNow: () => run({ status: 'queued', started_at: null, ended_at: null }),
      getTask: () => task({ running: true, runs: [run({ status: 'queued' })] }),
    });
    renderPage(call);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Ejecutar ahora Budget check diario' }),
    );
    expect(await screen.findByText('Budget check diario en cola')).toBeInTheDocument();
    expect(call).toHaveBeenCalledWith('runTaskNow', {
      path: { task_id: 'a'.repeat(32) },
      body: {},
    });
  });

  it('a task whose owner lost access says so and cannot be resumed nor run', async () => {
    const lost = task({
      status: 'paused',
      paused_reason: 'access_lost',
      paused_at: '2026-10-15T09:00:00Z',
      health: { tone: 'red', code: 'access_lost' },
      runs: [run({ status: 'skipped', reason: 'access_lost', has_result: false })],
    });
    renderPage(apiWith(base(list([lost]))));
    await userEvent.click(await screen.findByText('Budget check diario', { selector: '.mk-name' }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(/Pausada automáticamente/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Ejecutar ahora/ })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Reanudar' })).toBeDisabled();
    expect(within(panel).getByText('El creador perdió el acceso al agente')).toBeInTheDocument();
  });

  it('an administrator sees that only the owner edits, runs or resumes a task', async () => {
    renderPage(apiWith(base(list([task({ is_owner: false })]))));
    await userEvent.click(await screen.findByText('Budget check diario', { selector: '.mk-name' }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(/Solo Usuario 1 puede editarla/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Editar/ })).toBeNull();
    expect(within(panel).getByRole('button', { name: /Retirar/ })).toBeInTheDocument();
  });

  it('retiring needs a reason', async () => {
    const call = apiWith({
      ...base(list([task()])),
      retireExistingTask: () =>
        task({ status: 'retired', retired: { by: 'u', at: 'now', reason: 'Duplicada' } }),
    });
    renderPage(call);
    await userEvent.click(await screen.findByText('Budget check diario', { selector: '.mk-name' }));
    const panel = await screen.findByRole('dialog');
    await userEvent.click(within(panel).getByRole('button', { name: /Retirar/ }));
    // Asking for the reason leaves one «Retirar»: the one that confirms.
    const confirm = within(panel).getByRole('button', { name: /Retirar/ });
    expect(confirm).toBeDisabled();
    await userEvent.type(
      within(panel).getByLabelText('Motivo del retiro (obligatorio)'),
      'Duplicada',
    );
    await userEvent.click(confirm);
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('retireExistingTask', {
        path: { task_id: 'a'.repeat(32) },
        body: { reason: 'Duplicada' },
      });
    });
  });

  it('shows the result of a run as Markdown without raw HTML', async () => {
    const call = apiWith({
      ...base(list([task()])),
      getTaskRun: () => ({ ...run(), result: `**Total** USD 10 ${XSS}` }),
    });
    renderPage(call);
    await userEvent.click(await screen.findByText('Budget check diario', { selector: '.mk-name' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ver resultado' }));
    expect(await screen.findByText('Total')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('creates a scheduled task with the fields of the design', async () => {
    const created = task({ task_id: 'c'.repeat(32), name: 'Semanal' });
    const call = apiWith({ ...base(list([])), createNewTask: () => created });
    renderPage(call);
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo schedule' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear schedule' }));
    expect(within(dialog).getByText('Escribe un nombre · Describe la tarea')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Nombre'), 'Semanal');
    await userEvent.type(within(dialog).getByLabelText('Tarea'), 'Revisa el gasto');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Semanal' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear schedule' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('createNewTask', {
        body: {
          name: 'Semanal',
          agent_id: 'finops',
          task: 'Revisa el gasto',
          trigger: {
            kind: 'schedule',
            schedule: { freq: 'weekly', hour: 9, minute: 0, days: [1, 4], dow: 1, dom: 1 },
            timezone: 'America/Mexico_City',
          },
          deliver: 'inbox',
        },
      });
    });
    expect(await screen.findByText('Schedule creado')).toBeInTheDocument();
  });

  it('only central people may choose the cost anomaly trigger', async () => {
    renderPage(apiWith(base(list([], { can_subscribe_events: false }))));
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo schedule' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('button', { name: 'Cuando haya una anomalía de costo' }),
    ).toBeDisabled();
    expect(
      within(dialog).getByText(
        'Solo las personas centrales pueden suscribirse a las anomalías de costo.',
      ),
    ).toBeInTheDocument();
  });

  it('a task on cost anomalies shows its trigger and its daily cap', async () => {
    const anomaly = task({
      name: 'Anomalías',
      trigger: {
        kind: 'event',
        schedule: null,
        timezone: null,
        event_type: 'cost_anomaly',
        daily_cap: 5,
      },
      next_runs: [],
      runs: [run({ trigger: 'event', status: 'skipped', reason: 'daily_cap', has_result: false })],
    });
    renderPage(apiWith(base(list([anomaly]))));
    expect(await screen.findByText('Al detectar una anomalía de costo')).toBeInTheDocument();
    expect(screen.getByText('Hasta 5 investigaciones por día')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Anomalías', { selector: '.mk-name' }));
    expect(
      await screen.findByText('Se alcanzó el tope de investigaciones del día'),
    ).toBeInTheDocument();
  });

  it('says when the list cannot be loaded and retries', async () => {
    let fail = true;
    renderPage(
      apiWith({
        listTasksOfCaller: () =>
          fail ? new ApiError(503, 'tasks_unavailable', 'x') : list([task()]),
        getAgents: () => AGENTS,
      }),
    );
    expect(await screen.findByText('No se pudieron cargar los schedules')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
    expect(
      await screen.findByText('Budget check diario', { selector: '.mk-name' }),
    ).toBeInTheDocument();
  });

  it('a pause of an administrator is lifted only by an administrator (D2)', async () => {
    const paused = task({
      status: 'paused',
      paused_reason: 'admin',
      paused_at: '2026-10-15T09:00:00Z',
    });
    renderPage(apiWith(base(list([paused]))));
    await userEvent.click(await screen.findByText('Budget check diario', { selector: '.mk-name' }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(/Pausada por un administrador/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Ejecutar ahora/ })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Reanudar' })).toBeDisabled();
  });

  it('an administrator resumes what an administrator paused', async () => {
    const paused = task({
      status: 'paused',
      paused_reason: 'admin',
      paused_at: '2026-10-15T09:00:00Z',
      is_owner: false,
    });
    const call = apiWith({
      ...base(list([paused])),
      resumePausedTask: () => task({ is_owner: false }),
    });
    renderPage(call, true);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Reanudar Budget check diario' }),
    );
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('resumePausedTask', {
        path: { task_id: 'a'.repeat(32) },
        body: {},
      });
    });
  });

  it('an administrator holds a task its owner paused', async () => {
    const paused = task({
      status: 'paused',
      paused_reason: 'owner',
      paused_at: '2026-10-15T09:00:00Z',
      is_owner: false,
    });
    const call = apiWith({
      ...base(list([paused])),
      pauseExistingTask: () => ({ ...paused, paused_reason: 'admin' }),
    });
    renderPage(call, true);
    await userEvent.click(await screen.findByText('Budget check diario', { selector: '.mk-name' }));
    const panel = await screen.findByRole('dialog');
    await userEvent.click(within(panel).getByRole('button', { name: 'Pausar' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('pauseExistingTask', {
        path: { task_id: 'a'.repeat(32) },
        body: {},
      });
    });
  });
});
