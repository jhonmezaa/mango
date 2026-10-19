import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { openDownload, type RunReport } from './model';
import { SchedulesPage } from './SchedulesPage';
import { AGENTS, list, run, task } from './testFixtures';

/* Design part D (D86): the PDF of a run in «Ejecuciones recientes» and in the result. */

const opened = vi.hoisted(() => [] as string[]);
vi.mock('./model', async (original) => {
  const actual = await original<typeof import('./model')>();
  return {
    ...actual,
    // The SPA opens the link and nothing else: navigation itself is the browser's.
    openDownload: (url: string) => {
      opened.push(url);
      return url.startsWith('https://');
    },
  };
});

type Handler = (input: { path?: Record<string, string>; body?: unknown }) => unknown;

function apiWith(handlers: Record<string, Handler>) {
  return vi.fn((operation: string, input: Parameters<Handler>[0] = {}) => {
    const handler = handlers[operation];
    if (!handler) return Promise.reject(new Error(`unexpected ${operation}`));
    const answer = handler(input);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
}

function renderAt(call: ReturnType<typeof vi.fn>, path: string, isAdmin = false) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders
      session={sessionValue({ api, me: { ...baseMe, is_admin: isAdmin } })}
      path={path}
    >
      <Routes>
        <Route path="schedules/*" element={<SchedulesPage />} />
      </Routes>
    </TestProviders>,
  );
}

const READY: RunReport = {
  type: 'cost_summary',
  status: 'ready',
  reason: null,
  period: 'septiembre 2026',
  file: 'cierre-2026-10-01-0800.pdf',
  pages: 2,
  size_bytes: 405 * 1024,
  keep_until: '2026-12-30',
};
const TASK = 'a'.repeat(32);
const RUN = 'b'.repeat(32);
const detail = { result: 'El **informe**.', steps: [] };

describe('task reports', () => {
  it('shows a ready PDF with its file, size and date, and downloads it with a new link', async () => {
    const owned = task({ report: 'cost_summary', runs: [run({ report: READY })] });
    const call = apiWith({
      listTasksOfCaller: () => list([owned]),
      getAgents: () => AGENTS,
      getTask: () => owned,
      getTaskRun: () => ({ ...run({ report: READY }), ...detail }),
      downloadTaskReport: () => ({ url: 'https://bucket.example/x.pdf?sig', file: READY.file }),
    });
    renderAt(call, `/schedules/${TASK}/run/${RUN}`);
    expect(await screen.findByText('Resumen de costos · septiembre 2026')).toBeInTheDocument();
    expect(screen.getByText('cierre-2026-10-01-0800.pdf')).toBeInTheDocument();
    expect(
      screen.getByText('PDF · 2 páginas · 405 KB · se guarda hasta el 30 dic 2026'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Solo tú ves este resultado y descargas el PDF: se obtuvo con tu acceso. Cada descarga queda en Auditoría.',
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Descargar' }));
    await waitFor(() => {
      expect(opened).toContain('https://bucket.example/x.pdf?sig');
    });
    expect(call).toHaveBeenCalledWith('downloadTaskReport', {
      path: { task_id: TASK, run_id: RUN },
      body: {},
    });
    // The link is never shown.
    expect(screen.queryByText(/bucket\.example/)).toBeNull();
  });

  it('says it could not prepare the download', async () => {
    const owned = task({ report: 'cost_summary', runs: [run({ report: READY })] });
    renderAt(
      apiWith({
        listTasksOfCaller: () => list([owned]),
        getAgents: () => AGENTS,
        getTask: () => owned,
        getTaskRun: () => ({ ...run({ report: READY }), ...detail }),
        downloadTaskReport: () => new Error('boom'),
      }),
      `/schedules/${TASK}/run/${RUN}`,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Descargar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No se pudo preparar la descarga. Vuelve a intentarlo.',
    );
  });

  it('generates a PDF again only after render, without running the agent', async () => {
    const failed: RunReport = {
      ...READY,
      status: 'failed',
      reason: 'render',
      file: null,
      pages: null,
    };
    const owned = task({ report: 'cost_summary', runs: [run({ report: failed })] });
    const call = apiWith({
      listTasksOfCaller: () => list([owned]),
      getAgents: () => AGENTS,
      getTask: () => owned,
      getTaskRun: () => ({ ...run({ report: failed }), ...detail }),
      retryTaskReport: () => run({ report: { ...failed, status: 'generating', reason: null } }),
    });
    renderAt(call, `/schedules/${TASK}/run/${RUN}`);
    expect(
      await screen.findByText('No se pudo generar el PDF · Resumen de costos'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No se pudo armar el PDF\. Puedes generarlo de nuevo/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Generar de nuevo' }));
    expect(await screen.findByText('Generando el PDF · Resumen de costos')).toBeInTheDocument();
    expect(call).toHaveBeenCalledWith('retryTaskReport', {
      path: { task_id: TASK, run_id: RUN },
      body: {},
    });
  });

  it('a PDF without the agent data offers no retry', async () => {
    const failed: RunReport = { ...READY, status: 'failed', reason: 'data', file: null };
    const owned = task({ report: 'cost_summary', runs: [run({ report: failed })] });
    renderAt(
      apiWith({
        listTasksOfCaller: () => list([owned]),
        getAgents: () => AGENTS,
        getTask: () => owned,
        getTaskRun: () => ({ ...run({ report: failed }), ...detail }),
      }),
      `/schedules/${TASK}/run/${RUN}`,
    );
    expect(
      await screen.findByText(
        /El agente no entregó los datos del reporte\. El informe de abajo está completo\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generar de nuevo' })).toBeNull();
  });

  it('the lines of the runs say how each PDF is, and only the owner downloads', async () => {
    const runs = [
      run({ run_id: 'c'.repeat(32), report: { ...READY, status: 'generating', file: null } }),
      run({ run_id: 'd'.repeat(32), report: { ...READY, status: 'failed', reason: 'render' } }),
      run({ report: READY }),
    ];
    const owned = task({ report: 'cost_summary', runs });
    renderAt(
      apiWith({
        listTasksOfCaller: () => list([owned]),
        getAgents: () => AGENTS,
        getTask: () => owned,
      }),
      `/schedules/${TASK}`,
    );
    expect(await screen.findByText('Generando el PDF…')).toBeInTheDocument();
    expect(screen.getByText('No se generó el PDF')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Descargar PDF' })).toBeInTheDocument();
    expect(screen.getByText('PDF · Resumen de costos · solo tú lo descargas')).toBeInTheDocument();
  });

  it('an administrator reads that the PDF is ready, without a button', async () => {
    const shown: RunReport = { ...READY, period: null, file: null, pages: null, size_bytes: null };
    const other = task({
      report: 'cost_summary',
      is_owner: false,
      runs: [run({ report: shown, has_result: false })],
    });
    renderAt(
      apiWith({
        listTasksOfCaller: () => list([other]),
        getAgents: () => AGENTS,
        getTask: () => other,
      }),
      `/schedules/${TASK}`,
      true,
    );
    const panel = await screen.findByRole('dialog');
    expect(
      await within(panel).findByText('PDF listo · solo Usuario 1 lo descarga'),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Descargar/ })).toBeNull();
    expect(
      within(panel).getByText('PDF · Resumen de costos · solo Usuario 1 lo descarga'),
    ).toBeInTheDocument();
  });
});

describe('openDownload', () => {
  it('opens only https links', async () => {
    const real = await vi.importActual<typeof import('./model')>('./model');
    expect(real.openDownload('javascript:alert(1)')).toBe(false);
    expect(real.openDownload('http://bucket.example/x.pdf')).toBe(false);
    expect(real.openDownload('not a url')).toBe(false);
    expect(openDownload).not.toBe(real.openDownload);
  });
});
