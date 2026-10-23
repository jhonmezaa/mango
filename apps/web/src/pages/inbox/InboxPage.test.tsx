import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { NOW, XSS, approval, source } from '../approvals/testFixtures';
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

const list = async () => within(await screen.findByRole('listbox', { name: 'Avisos' }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function narrowScreen() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width: 900px'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

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
    // Design: the approval body goes in mono, the run summaries do not.
    expect(within(rows[0] as HTMLElement).getByText(/^aws-budgets\.create_budget · /)).toHaveClass(
      'mono',
    );
    expect(rows[1]?.querySelector('.mono')).toBeNull();
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
    expect(document.querySelector('.inbox-detail-b')).toHaveClass('mono');
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
    // Design 2026-10-16b: «Archivado» is a button, not a tab, and it goes back to the inbox.
    expect(screen.queryByRole('tab', { name: 'Archivado' })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('button', { name: 'Volver a la bandeja' })).toBeVisible();
  });

  it('«Mostrar más» loads the next page, and says so when it fails (design 2026-10-16b)', async () => {
    const user = userEvent.setup();
    let fail = true;
    const second = runItem(
      { item_id: `${String(NOW - 5)}${'f'.repeat(16)}` },
      { task_name: 'Rightsizing semanal' },
    );
    const call = vi.fn();
    call.mockImplementation((operation: string, input: { query?: Record<string, string> } = {}) => {
      if (operation !== 'listInbox') return Promise.reject(new Error(operation));
      if (!input.query?.cursor) return Promise.resolve(page([runItem()], { next_cursor: 'next' }));
      if (fail) {
        fail = false;
        return Promise.reject(new Error('down'));
      }
      return Promise.resolve(page([second]));
    });
    renderPage(call);
    await user.click(await screen.findByRole('button', { name: 'Mostrar más' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron cargar más avisos.');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await (await list()).findByText('Rightsizing semanal · completada')).toBeVisible();
    // The last page: no button.
    expect(screen.queryByRole('button', { name: 'Mostrar más' })).toBeNull();
  });

  it('on a narrow screen the detail replaces the list and goes back (design 2026-10-16b)', async () => {
    narrowScreen();
    const user = userEvent.setup();
    const call = apiWith({
      listInbox: () => page([runItem({ read: true })]),
    });
    renderPage(call);
    await user.click(await (await list()).findByText('Budget check diario · completada'));
    expect(screen.getByRole('heading', { name: 'Budget check diario · completada' })).toHaveFocus();
    expect(document.querySelector('.inbox')).toHaveClass('show-detail');
    await user.click(screen.getByRole('button', { name: 'Volver a la lista' }));
    expect(document.querySelector('.inbox')).not.toHaveClass('show-detail');
    await user.click(await (await list()).findByText('Budget check diario · completada'));
    await user.keyboard('{Escape}');
    expect(document.querySelector('.inbox')).not.toHaveClass('show-detail');
  });

  it('a notice that could not be marked as read stays unread, without an error', async () => {
    const user = userEvent.setup();
    const call = vi.fn();
    call.mockImplementation((operation: string) =>
      operation === 'listInbox'
        ? Promise.resolve(page([runItem()]))
        : Promise.reject(new Error(operation)),
    );
    renderPage(call);
    await user.click(await (await list()).findByText('Budget check diario · completada'));
    await waitFor(() => {
      expect(document.querySelector('.inbox-row.is-unread')).not.toBeNull();
    });
    expect(screen.queryByText('No se pudo guardar el cambio. Vuelve a intentarlo.')).toBeNull();
  });
});

describe('bucket proposals of knowledge bases (D88 (49))', () => {
  function sourceItem(overrides: Partial<InboxItem> = {}): InboxItem {
    const proposal = source();
    return {
      kind: 'kbsource',
      item_id: proposal.src_id,
      agent_id: null,
      agent_name: null,
      at: proposal.proposed_at,
      read: false,
      archived: false,
      approval: null,
      source: proposal,
      run: null,
      ...overrides,
    };
  }

  it('pins one to sign with its card, its decision and where to go', async () => {
    const call = apiWith({
      listInbox: () => page([sourceItem()]),
      unreadInbox: () => ({ unread: 1 }),
      putInboxState: ({ path }) => ({ ...sourceItem(), read: true, item_id: path?.item_id }),
      approveSource: () => ({}),
    });
    renderPage(call);
    const rows = await list();
    const row = await rows.findByRole('option', {
      name: /Te piden aprobar: Leer un bucket en Security Baseline/,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(row);
    expect(await screen.findByText('Knowledge Bases', { exact: false })).toBeInTheDocument();
    expect(
      screen.getByText('Es de la cuenta de AWS de la instalación y no es de Mango.'),
    ).toBeInTheDocument();
    // Compact: no frequency, and «Aprobar» approves at once.
    expect(screen.queryByText('Frecuencia')).toBeNull();
    expect(screen.getByRole('button', { name: /Abrir knowledge base/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Ver en Aprobaciones/ }));
    expect(await screen.findByText('approvals')).toBeInTheDocument();
  });

  it('says so when a page arrived empty but there is more', async () => {
    renderPage(
      apiWith({
        listInbox: () => page([], { next_cursor: `${String(NOW)}${'e'.repeat(16)}` }),
        unreadInbox: () => ({ unread: 0 }),
      }),
    );
    expect(await screen.findByText('Nada entre los avisos más recientes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mostrar más' })).toBeInTheDocument();
  });
});
