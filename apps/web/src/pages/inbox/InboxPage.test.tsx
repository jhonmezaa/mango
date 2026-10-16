import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { NOW, XSS, approval } from '../approvals/testFixtures';
import { InboxPage } from './InboxPage';
import type { InboxItem, InboxPage as Page } from './model';

type Handler = (input: {
  path?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}) => unknown;

function apiWith(handlers: Record<string, Handler>) {
  return vi.fn((operation: string, input: Parameters<Handler>[0] = {}) => {
    const handler = handlers[operation];
    if (!handler) return Promise.reject(new Error(`unexpected ${operation}`));
    return Promise.resolve(handler(input));
  });
}

const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const TASK = 'b'.repeat(32);
const RUN = 'c'.repeat(32);

function runItem(overrides: Partial<InboxItem> = {}, run: Partial<InboxItem['run']> = {}) {
  return {
    kind: 'run',
    item_id: `${String(NOW)}${'d'.repeat(16)}`,
    agent_id: 'finops',
    agent_name: 'FinOps',
    at: iso(-60),
    read: false,
    archived: false,
    approval: null,
    run: {
      task_id: TASK,
      run_id: RUN,
      task_name: 'Budget check diario',
      ok: true,
      summary: 'Gasto del mes: USD 2.400,00',
      reason: null,
      ...run,
    },
    ...overrides,
  } as InboxItem;
}

function approvalItem(overrides: Partial<InboxItem> = {}): InboxItem {
  const request = approval({ can_sign: true });
  return {
    kind: 'approval',
    item_id: request.approval_id,
    agent_id: 'finops',
    agent_name: 'FinOps',
    at: request.created_at,
    read: false,
    archived: false,
    approval: request,
    run: null,
    ...overrides,
  };
}

function page(items: InboxItem[], extra: Partial<Page> = {}): Page {
  return { items, next_cursor: null, unread: 2, can_decide: true, ...extra };
}

function renderPage(call: ReturnType<typeof vi.fn>, path = '/inbox') {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders session={sessionValue({ api, me: baseMe })} path={path}>
      <Routes>
        <Route path="inbox/*" element={<InboxPage />} />
        <Route path="schedules/*" element={<p>schedules</p>} />
        <Route path="approvals/*" element={<p>approvals</p>} />
      </Routes>
    </TestProviders>,
  );
}

const list = async () => within(await screen.findByRole('listbox', { name: 'Notificaciones' }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InboxPage', () => {
  it('lists approvals and run notices as the design, everything as text', async () => {
    const call = apiWith({
      listInbox: () =>
        page([
          approvalItem(),
          runItem({}, { summary: XSS }),
          runItem(
            { item_id: `${String(NOW - 1)}${'e'.repeat(16)}`, read: true },
            { ok: false, summary: null, reason: 'budget_exceeded', task_name: 'Cohort Q3' },
          ),
        ]),
    });
    renderPage(call);
    expect(await screen.findByRole('heading', { level: 1, name: 'Bandeja' })).toBeVisible();
    const rows = (await list()).getAllByRole('option');
    expect(rows[0]).toHaveTextContent(
      'Te piden aprobar: Crear un presupuesto mensual de costo en AWS Budgets, sin notificaciones.',
    );
    expect(rows[0]).toHaveTextContent('FinOps · aws-budgets.create_budget · name=team-a');
    expect(within(rows[0] as HTMLElement).getByRole('img', { name: 'No leído' })).toBeVisible();
    expect(rows[1]).toHaveTextContent('Budget check diario · completada');
    expect(rows[1]).toHaveTextContent(`FinOps · ${XSS}`);
    expect(rows[2]).toHaveTextContent('Cohort Q3 · no se completó');
    expect(rows[2]).toHaveTextContent('Presupuesto agotado');
    expect(document.querySelector('img[src="x"]')).toBeNull();
    // «Menciones» has no backend: Próximamente, not a tab that does anything.
    const mentions = screen.getByRole('tab', { name: /Menciones/ });
    expect(mentions).toHaveAttribute('aria-disabled', 'true');
    expect(within(mentions).getByText('Próximamente')).toBeVisible();
    expect(screen.getByText('Selecciona una notificación para verla')).toBeVisible();
  });

  it('opening a notice reads it, and «Ver resultado» opens the run in Schedules', async () => {
    const user = userEvent.setup();
    const item = runItem();
    const call = apiWith({
      listInbox: () => page([item]),
      setInboxState: ({ body }) => ({ ...item, ...(body as object) }),
      unreadInbox: () => ({ unread: 0 }),
    });
    renderPage(call);
    await user.click((await list()).getByRole('option'));
    expect(call).toHaveBeenCalledWith('setInboxState', {
      path: { kind: 'run', item_id: item.item_id },
      body: { read: true },
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Budget check diario · completada' }));
    expect(screen.getByText('Ejecución')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Ver resultado/ }));
    expect(await screen.findByText('schedules')).toBeVisible();
  });

  it('a failed run offers «Ver ejecución»; archiving moves it out of «Todo»', async () => {
    const user = userEvent.setup();
    const item = runItem({ read: true }, { ok: false, summary: null, reason: 'mystery' });
    const call = apiWith({
      listInbox: () => page([item]),
      setInboxState: ({ body }) => ({ ...item, ...(body as object) }),
      unreadInbox: () => ({ unread: 0 }),
    });
    renderPage(call);
    await user.click((await list()).getByRole('option'));
    expect(screen.getAllByText('No se pudo completar').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Ver ejecución/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Archivar/ }));
    const toasts = document.querySelector('.g-toasts') as HTMLElement;
    expect(await within(toasts).findByText('Archivado')).toBeVisible();
    await waitFor(() => {
      expect(screen.getByText('Nada por aquí.')).toBeVisible();
    });
  });

  it('an approval opens with its decision card and a link to Aprobaciones', async () => {
    const user = userEvent.setup();
    const item = approvalItem({ read: true });
    renderPage(apiWith({ listInbox: () => page([item]) }));
    await user.click((await list()).getByRole('option'));
    expect(screen.getByText('Aprobación')).toBeVisible();
    expect(screen.getByRole('button', { name: /Firmar|Aprobar/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Ver en Aprobaciones/ }));
    expect(await screen.findByText('approvals')).toBeVisible();
  });

  it('marks everything as read', async () => {
    const user = userEvent.setup();
    const call = apiWith({
      listInbox: () => page([runItem()], { unread: 1 }),
      readAllInbox: () => ({ unread: 0 }),
    });
    renderPage(call);
    expect(await screen.findByText('1 sin leer')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Marcar todo como leído' }));
    expect(await screen.findByText('Todo al día')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Marcar todo como leído' })).toBeDisabled();
  });

  it('asks the API for the tab in the route; an unknown tab is «Todo»', async () => {
    const call = apiWith({ listInbox: () => page([], { unread: 0 }) });
    renderPage(call, '/inbox/archived');
    expect(await screen.findByText('Nada por aquí.')).toBeVisible();
    expect(call).toHaveBeenCalledWith(
      'listInbox',
      { query: { view: 'archived' } },
      expect.anything(),
    );
    expect(screen.getByRole('tab', { name: 'Archivado' })).toHaveAttribute('aria-selected', 'true');
  });
});
