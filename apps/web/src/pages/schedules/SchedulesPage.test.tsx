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

function renderPage(call: ReturnType<typeof vi.fn>, isAdmin = false, path = '/schedules') {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders
      session={sessionValue({ api, me: { ...baseMe, is_admin: isAdmin } })}
      path={path}
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
    expect(screen.getByText('FinOps · como tú')).toBeInTheDocument();
    expect(screen.getByText('cuándo corre')).toBeInTheDocument();
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
    expect(
      await screen.findByText(
        'Aún no tienes tareas. Para crear una necesitas un agente publicado que puedas usar.',
      ),
    ).toBeInTheDocument();
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
    renderPage(
      apiWith(
        base(list([task({ is_owner: false, task: null, runs: [run({ has_result: false })] })])),
      ),
      true,
    );
    await userEvent.click(await screen.findByText('Budget check diario', { selector: '.mk-name' }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(/Solo Usuario 1 puede editarla/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Editar/ })).toBeNull();
    expect(within(panel).getByRole('button', { name: /Retirar/ })).toBeInTheDocument();
    // D82 (3) and D78 (18): neither the instruction nor the results of someone else's task.
    expect(
      within(panel).getByText(/Solo Usuario 1 ve la instrucción y los resultados/),
    ).toBeInTheDocument();
    expect(within(panel).getByText('Los resultados solo los ve Usuario 1.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Ver resultado' })).toBeNull();
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
    await userEvent.type(within(panel).getByLabelText('Motivo del retiro'), 'Duplicada');
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
      getTaskRun: () => ({
        ...run(),
        result: `**Total** USD 10 ${XSS}`,
        steps: [{ text: `Consulto ${XSS}`, tool: 'get_budgets' }],
      }),
    });
    renderPage(call);
    await userEvent.click(await screen.findByText('Budget check diario', { selector: '.mk-name' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ver resultado' }));
    // Inside the panel of the task (design 2.1), with its steps and the report.
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText('Total')).toBeInTheDocument();
    expect(within(panel).getByText('Pasos · 1 consulta')).toBeInTheDocument();
    expect(within(panel).getByText('get_budgets')).toBeInTheDocument();
    expect(
      within(panel).getByText('Solo tú ves este resultado: se obtuvo con tu acceso.'),
    ).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    await userEvent.click(within(panel).getByRole('button', { name: /Volver a la tarea/ }));
    expect(within(panel).getByText('entrega y control')).toBeInTheDocument();
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
      within(dialog).getByRole('button', { name: 'Al detectar una anomalía de costo' }),
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
    expect(screen.getByText('Hasta 5 por día')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Anomalías', { selector: '.mk-name' }));
    const panel = await screen.findByRole('dialog');
    expect(
      await within(panel).findByText('Se alcanzó el tope de investigaciones del día'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('Hasta 5 investigaciones por día')).toBeInTheDocument();
    expect(
      within(panel).getByText('Una a la vez; la siguiente espera en cola'),
    ).toBeInTheDocument();
    // An anomaly task is never run on demand: there is no anomaly to investigate.
    expect(within(panel).queryByRole('button', { name: /Ejecutar ahora/ })).toBeNull();
  });

  it('says why a waiting run did not run when its task was paused (D81)', async () => {
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
      runs: [
        run({
          run_id: 'r1',
          trigger: 'event',
          status: 'skipped',
          reason: 'task_paused',
          has_result: false,
        }),
        run({
          run_id: 'r2',
          trigger: 'event',
          status: 'skipped',
          reason: 'paused_by_admin',
          has_result: false,
        }),
      ],
    });
    renderPage(apiWith(base(list([anomaly]))));
    await userEvent.click(await screen.findByText('Anomalías', { selector: '.mk-name' }));
    expect(await screen.findByText('La tarea se pausó')).toBeInTheDocument();
    expect(screen.getByText('Un administrador pausó la tarea')).toBeInTheDocument();
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
    // D82 (2): an administrator says why.
    const confirm = within(panel).getByRole('button', { name: 'Pausar' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(panel).getByLabelText('Motivo de la pausa'), 'Revisemos el costo');
    await userEvent.click(confirm);
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('pauseExistingTask', {
        path: { task_id: 'a'.repeat(32) },
        body: { reason: 'Revisemos el costo' },
      });
    });
  });

  it('the owner reads why an administrator paused the task (D82 (2))', async () => {
    const paused = task({
      status: 'paused',
      paused_reason: 'admin',
      paused_at: '2026-10-15T09:00:00Z',
      paused_note: 'Revisemos el costo antes de seguir.',
    });
    renderPage(apiWith(base(list([paused]))));
    expect(await screen.findByText('Pausada por un admin')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Budget check diario', { selector: '.mk-name' }));
    const panel = await screen.findByRole('dialog');
    expect(
      within(panel).getByText('Motivo: Revisemos el costo antes de seguir.'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText('Un administrador la pausó: solo un administrador la reanuda.'),
    ).toBeInTheDocument();
  });

  it('shows the anomaly of a run and that a run waits for the previous one (D81)', async () => {
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
      runs: [
        run({
          run_id: 'r1',
          trigger: 'event',
          status: 'queued',
          started_at: null,
          ended_at: null,
          has_result: false,
          waiting_since: '2026-10-15T14:30:00Z',
          anomaly: { start: '2026-10-14', end: '2026-10-15' },
        }),
        run({
          run_id: 'r2',
          trigger: 'event',
          waiting_since: '2026-10-15T14:28:00Z',
          started_at: '2026-10-15T14:30:00Z',
          anomaly: {
            start: '2026-10-14',
            end: '2026-10-14',
            id: '8d09e1c2-4b5d-4e8f-9a01-8d092b3c4d5e',
          },
        }),
      ],
    });
    renderPage(apiWith(base(list([anomaly]))));
    expect(await screen.findByText('En cola')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Anomalías', { selector: '.mk-name' }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Anomalía · 14–15 oct')).toBeInTheDocument();
    expect(
      within(panel).getByText('Espera a que termine la investigación anterior'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('Esperó 2 min en cola')).toBeInTheDocument();
    // D85: the short id of the anomaly tells apart those of the same day (design 2026-10-16b).
    expect(within(panel).getByText('8d09e1c2')).toHaveClass('mono');
    expect(within(panel).queryByText(/8d09e1c2-4b5d/)).toBeNull();
  });

  it('the editor shows the next runs the server computes in the zone of the task', async () => {
    const call = apiWith({
      ...base(list([])),
      previewNextRuns: () => ({
        next_runs: ['2026-10-17T14:00:00Z', '2026-10-18T14:00:00Z', '2026-10-19T14:00:00Z'],
      }),
    });
    renderPage(call);
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo schedule' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText(/^Próximas, hora de Ciudad de México:/),
    ).toBeInTheDocument();
    expect(call).toHaveBeenCalledWith(
      'previewNextRuns',
      {
        body: {
          schedule: { freq: 'daily', hour: 9, minute: 0, days: [1, 4], dow: 1, dom: 1 },
          timezone: 'America/Mexico_City',
        },
      },
      expect.anything(),
    );
    expect(
      within(dialog).getByText(
        'Queda en el detalle de la tarea y te llega a la Bandeja. Solo tú lo ves.',
      ),
    ).toBeInTheDocument();
  });

  it('nobody creates without a usable agent', async () => {
    renderPage(apiWith({ listTasksOfCaller: () => list([]), getAgents: () => ({ items: [] }) }));
    const button = await screen.findByRole('button', { name: 'Nuevo schedule' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'No tienes agentes publicados que puedas usar');
  });

  it('a run skipped for lack of budget puts the task in «Necesitan atención»', async () => {
    renderPage(
      apiWith(
        base(
          list([
            task({
              health: { tone: 'amber', code: 'budget_skipped' },
              runs: [run({ status: 'skipped', reason: 'budget_exceeded', has_result: false })],
            }),
          ]),
        ),
      ),
    );
    expect(
      await screen.findByTitle('La última ejecución se omitió: presupuesto agotado'),
    ).toHaveClass('badge-amber');
  });

  it('a run that is gone opens its task with a notice (design 2026-10-16b)', async () => {
    renderPage(
      apiWith(base(list([task()]))),
      false,
      `/schedules/${'a'.repeat(32)}/run/${'f'.repeat(32)}`,
    );
    expect(await screen.findByText('Esa ejecución ya no está disponible')).toBeInTheDocument();
    expect(screen.getByText('Los resultados se guardan 90 días.')).toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: 'Budget check diario' })).toBeInTheDocument();
  });

  it('the editor shows the downloadable report as «Próximamente»', async () => {
    renderPage(apiWith(base(list([]))));
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo schedule' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Reporte descargable')).toBeInTheDocument();
    const option = within(dialog).getAllByText('También un PDF con gráficos')[0];
    const soon = option?.closest('.soon');
    expect(soon).not.toBeNull();
    expect(within(soon as HTMLElement).getByText('Próximamente')).toBeInTheDocument();
    expect(within(soon as HTMLElement).getByRole('checkbox', { hidden: true })).toBeDisabled();
  });
});
