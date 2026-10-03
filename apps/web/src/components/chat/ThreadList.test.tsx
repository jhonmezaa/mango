import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../agents/agents';
import type { ConversationSummary } from '../../api/schemas';
import { agentFixture, finopsAgent } from '../../test/fixtures';
import { formatThreadTime, groupThreads } from './threadGroups';
import { ThreadList } from './ThreadList';

// Wednesday 30 Sep 2026, 15:00 local time.
const NOW = new Date(2026, 8, 30, 15, 0);
const at = (day: number, hour: number) => new Date(2026, 8, day, hour, 4).toISOString();

const CONVERSATIONS: ConversationSummary[] = [
  {
    conversation_id: '01A',
    title: 'Gasto de EC2 en septiembre',
    updated_at: at(30, 12),
    agent_id: 'finops',
  },
  {
    conversation_id: '01B',
    title: 'Pronóstico de fin de mes',
    updated_at: at(29, 10),
    agent_id: 'finops',
  },
  {
    conversation_id: '01C',
    title: 'Anomalías de la semana',
    updated_at: at(26, 9),
    agent_id: 'abcdefghijklmnop',
  },
  {
    conversation_id: '01D',
    title: 'Savings Plans de agosto',
    updated_at: at(12, 9),
    agent_id: 'zzzzzzzzzzzzzzzz',
  },
];

const SALES = agentFixture({
  id: 'abcdefghijklmnop',
  name: '<i>Ventas</i>',
  icon: 'Zap',
  color: 3,
});
const AGENTS: ReadonlyMap<string, Agent> = new Map([
  [finopsAgent.id, finopsAgent],
  [SALES.id, SALES],
]);

function renderList(conversations: ConversationSummary[] | null, activeId: string | null = null) {
  render(
    <MemoryRouter>
      <ThreadList
        conversations={conversations}
        agents={AGENTS}
        error={false}
        activeId={activeId}
        onNew={vi.fn()}
        onRetry={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('threadGroups', () => {
  it('groups by day: hoy, ayer, esta semana and anteriores', () => {
    const groups = groupThreads(CONVERSATIONS, NOW);
    expect(groups.map((group) => [group.key, group.items.map((i) => i.conversation_id)])).toEqual([
      ['today', ['01A']],
      ['yesterday', ['01B']],
      ['week', ['01C']],
      ['older', ['01D']],
    ]);
  });

  it('formats the row time like the design and keeps unparseable input as text', () => {
    expect(formatThreadTime(at(30, 12), 'Ayer', NOW)).toBe('12:04');
    expect(formatThreadTime(at(29, 10), 'Ayer', NOW)).toBe('Ayer');
    expect(formatThreadTime(at(26, 9), 'Ayer', NOW)).toMatch(/^sáb/);
    expect(formatThreadTime(at(12, 9), 'Ayer', NOW)).toMatch(/^12 sept/);
    expect(formatThreadTime('nope', 'Ayer', NOW)).toBe('nope');
  });
});

describe('ThreadList', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the history grouped by day with the active conversation marked', () => {
    renderList(CONVERSATIONS, '01B');
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['hoy', 'ayer', 'esta semana', 'anteriores']);
    const yesterday = screen.getByRole('region', { name: 'ayer' });
    expect(within(yesterday).getByRole('link', { name: /Pronóstico/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('filters by title, ignoring case and surrounding spaces', async () => {
    const user = userEvent.setup();
    renderList(CONVERSATIONS);
    await user.type(screen.getByRole('searchbox'), '  ec2 ');
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/c/01A');
  });

  it('says when nothing matches and when there is no history', async () => {
    const user = userEvent.setup();
    renderList(CONVERSATIONS);
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText('Sin resultados para “zzz”')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows a five-row skeleton announced as "Cargando historial" while loading', () => {
    renderList(null);
    // Design chat.jsx ThreadList state="loading".
    const loading = screen.getByRole('status', { name: 'Cargando historial' });
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(loading).not.toHaveAttribute('aria-hidden');
    expect(loading.children).toHaveLength(5);
    expect(screen.queryByText('Aún no tienes conversaciones.')).toBeNull();
  });

  it('removes the skeleton once the history arrives', () => {
    renderList(CONVERSATIONS);
    expect(screen.queryByRole('status', { name: 'Cargando historial' })).toBeNull();
  });

  it('shows the empty-history message', () => {
    renderList([]);
    expect(screen.getByText('Aún no tienes conversaciones.')).toBeInTheDocument();
  });

  it('offers "Reintentar" when the history fails to load', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <MemoryRouter>
        <ThreadList
          conversations={null}
          agents={AGENTS}
          error
          activeId={null}
          onNew={vi.fn()}
          onRetry={onRetry}
        />
      </MemoryRouter>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('No se pudo cargar el historial.');
    await user.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows the agent of each conversation, as text, and a neutral one when it is not listed', () => {
    renderList(CONVERSATIONS);
    const row = (title: string) => screen.getByRole('link', { name: new RegExp(title) });
    expect(within(row('Gasto de EC2')).getByText('FinOps')).toBeInTheDocument();
    const sales = row('Anomalías de la semana');
    expect(within(sales).getByText('<i>Ventas</i>')).toBeInTheDocument();
    expect(sales.querySelector('i')).toBeNull();
    expect(sales.querySelector('.agent-avatar')).toHaveClass('mk-avatar-c3');
    // An agent the user can no longer use (or one the list does not carry).
    const unknown = row('Savings Plans de agosto');
    expect(within(unknown).getByText('Agente')).toBeInTheDocument();
    expect(unknown.querySelector('.agent-avatar')).toHaveClass('agent-avatar-unknown');
  });
});
