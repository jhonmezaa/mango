import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../agents/agents';
import type { Me } from '../api/schemas';
import { agentFixture, baseMe, finopsAgent, sessionValue } from '../test/fixtures';
import { useShell } from '../layouts/ShellContext';
import { TestProviders } from '../test/TestProviders';
import { Sidebar } from './Sidebar';

const noop = () => undefined;

function renderSidebar(
  isAdmin: boolean,
  path = '/',
  collapsed = false,
  role: Me['role'] = 'bu-lead',
) {
  const me: Me = {
    ...baseMe,
    role,
    business_unit: role === 'bu-lead' ? 'finanzas' : null,
    is_admin: isAdmin,
  };
  return render(
    <TestProviders session={sessionValue({ me })} path={path}>
      <Sidebar mode="full" collapsed={collapsed} onToggleCollapsed={noop} onNavigate={noop} />
    </TestProviders>,
  );
}

const nav = () => screen.getByRole('navigation', { name: 'Navegación principal' });

/** What the shell learns from the API: the Bandeja's unread count (D83). */
function InboxCount({ count }: { count: number }) {
  const { setInboxUnread } = useShell();
  useEffect(() => {
    setInboxUnread(count);
  }, [count, setInboxUnread]);
  return null;
}

describe('Sidebar · Bandeja', () => {
  it('shows the unread count of the Bandeja, and «99+» past it', () => {
    const { rerender } = render(
      <TestProviders session={sessionValue()} path="/">
        <InboxCount count={3} />
        <Sidebar mode="full" collapsed={false} onToggleCollapsed={noop} onNavigate={noop} />
      </TestProviders>,
    );
    const link = screen.getByRole('link', { name: 'Bandeja, 3 sin leer' });
    expect(within(link).getByText('3')).toBeVisible();
    rerender(
      <TestProviders session={sessionValue()} path="/">
        <InboxCount count={99} />
        <Sidebar mode="full" collapsed={false} onToggleCollapsed={noop} onNavigate={noop} />
      </TestProviders>,
    );
    expect(screen.getByText('99+')).toBeVisible();
  });
});

/** Enabled destinations (real links with an href). */
function navLinks() {
  return within(nav())
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-disabled') !== 'true')
    .map((link) => link.getAttribute('aria-label') ?? link.textContent);
}

/** Destinations shown as "Próximamente". */
function soonItems() {
  return within(nav())
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-disabled') === 'true')
    .map((link) => link.getAttribute('aria-label'));
}

afterEach(() => {
  window.localStorage.clear();
});

describe('Sidebar navigation', () => {
  it('shows the user views of the design, with Chat, Marketplace and Org Chart available, whatever storage says', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('mango-role', 'admin');
    window.localStorage.setItem('is_admin', 'true');
    renderSidebar(false);
    // Org Chart is a user view (design USER_VIEWS, oct 2026): the API filters the tree (D38).
    // So is the Actividad (D90): the API reads each person's own activity.
    await user.click(screen.getByRole('button', { name: 'Operación' }));
    await user.click(screen.getByRole('button', { name: 'Construir' }));
    expect(navLinks()).toEqual([
      'Chat',
      'Bandeja',
      'Marketplace',
      'Chat con FinOps',
      'Aprobaciones',
      'Actividad',
      'Schedules',
      'Org Chart',
    ]);
    expect(soonItems()).toEqual([
      'Inicio, próximamente',
      'Tickets, próximamente',
      'Buscar conversaciones, próximamente',
    ]);
    // Construir only has Schedules (design 2026-10-16, D82 (1)); admin screens and the
    // Catálogo de MCP are hidden.
    expect(screen.getByRole('button', { name: 'Gobernanza' })).toBeInTheDocument();
    expect(screen.queryByText('Catálogo de MCP')).toBeNull();
    expect(screen.queryByText('Audit log')).toBeNull();
    expect(screen.queryByText('Presupuestos')).toBeNull();
  });

  it('also shows the owner views to FinOps central without Admin (S1)', async () => {
    const user = userEvent.setup();
    renderSidebar(false, '/', false, 'finops-central');
    await user.click(screen.getByRole('button', { name: 'Construir' }));
    await user.click(screen.getByRole('button', { name: 'Operación' }));
    // Of the owner views, the Org Chart is available (read only; the API filters it, D38), the
    // Marketplace, Schedules (D78: the API lists only the caller's tasks) and Gobernanza (D89:
    // the API sends only the sections each one may read).
    expect(navLinks()).toEqual([
      'Chat',
      'Bandeja',
      'Marketplace',
      'Chat con FinOps',
      'Aprobaciones',
      'Gobernanza',
      'Actividad',
      'Schedules',
      'Org Chart',
    ]);
    expect(soonItems()).toEqual([
      'Inicio, próximamente',
      'Tickets, próximamente',
      'Buscar conversaciones, próximamente',
      'Skills, próximamente',
      'Observability, próximamente',
      'Evals, próximamente',
      'Costos, próximamente',
    ]);
    // Admin-only screens stay hidden.
    for (const label of ['Presupuestos', 'Audit log', 'Revisión de agentes', 'Brains']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('adds the Catálogo de MCP for agent creators (design CREATOR_VIEWS)', async () => {
    const user = userEvent.setup();
    render(
      <TestProviders
        session={sessionValue({
          me: {
            ...baseMe,
            role: null,
            groups: ['mango-agent-creator', 'people'],
            can: { create_agent: true },
          },
        })}
      >
        <Sidebar mode="full" collapsed={false} onToggleCollapsed={noop} onNavigate={noop} />
      </TestProviders>,
    );
    await user.click(screen.getByRole('button', { name: 'Construir' }));
    expect(screen.getByRole('link', { name: 'Catálogo de MCP' })).toHaveAttribute('href', '/mcp');
    for (const label of ['Presupuestos', 'Audit log', 'Revisión de agentes', 'Brains']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('shows every group to admins, with Presupuestos and Audit log available', () => {
    renderSidebar(true);
    expect(screen.getByRole('heading', { name: 'Plataforma' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Presupuestos' })).toHaveAttribute('href', '/budgets');
    expect(screen.getByRole('link', { name: 'Audit log' })).toHaveAttribute('href', '/audit');
    expect(screen.getByRole('button', { name: 'Gobernanza' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // Construir and Operación start closed (design default: only Gobernanza open).
    expect(screen.getByRole('button', { name: 'Construir' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Operación' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('renders unavailable destinations as disabled, non-navigable "Próximamente" rows', () => {
    renderSidebar(true);
    const item = screen.getByRole('link', { name: 'Inicio, próximamente' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).not.toHaveAttribute('href');
    expect(item).not.toHaveAttribute('tabindex');
    expect(item).toHaveTextContent('Próximamente');
  });

  it('pins the release agent by default, linking to a chat with it, without status pip', () => {
    const { container } = renderSidebar(false);
    const pinned = screen.getByRole('list', { name: 'Agentes fijados' });
    expect(within(pinned).getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Chat con FinOps' })).toHaveAttribute(
      'href',
      '/?agent=finops',
    );
    expect(container.querySelector('.sb-status-pip')).toBeNull();
  });

  it('shows the pinned agents the API lists for the user, in pin order, as text', () => {
    const other = agentFixture({ id: 'abcdefghijklmnop', name: '<b>Ventas</b>', icon: 'Zap' });
    const retired = agentFixture({ id: 'qrstuvwxyz234567', name: 'Viejo', status: 'retired' });
    // Storage is untrusted: malformed ids are dropped, unknown and retired agents not shown.
    window.localStorage.setItem(
      'mango-pinned-agents',
      JSON.stringify([
        'abcdefghijklmnop',
        '../x',
        42,
        'zzzzzzzzzzzzzzzz',
        'qrstuvwxyz234567',
        'finops',
      ]),
    );
    const noop = () => undefined;
    const { container } = render(
      <TestProviders session={sessionValue({ agents: [finopsAgent, other, retired] })}>
        <Sidebar mode="full" collapsed={false} onToggleCollapsed={noop} onNavigate={noop} />
      </TestProviders>,
    );
    const pinned = screen.getByRole('list', { name: 'Agentes fijados' });
    expect(
      within(pinned)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/?agent=abcdefghijklmnop', '/?agent=finops']);
    expect(within(pinned).getByText('<b>Ventas</b>')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
  });

  it('unpins an agent and remembers it', async () => {
    const user = userEvent.setup();
    renderSidebar(false);
    await user.click(screen.getByRole('button', { name: 'Quitar FinOps de fijados' }));
    expect(screen.queryByRole('list', { name: 'Agentes fijados' })).toBeNull();
    expect(window.localStorage.getItem('mango-pinned-agents')).toBe('[]');
  });

  it('shows no pinned section while the agents are unknown', () => {
    const noop = () => undefined;
    render(
      <TestProviders session={sessionValue({ agents: null })}>
        <Sidebar mode="full" collapsed={false} onToggleCollapsed={noop} onNavigate={noop} />
      </TestProviders>,
    );
    expect(screen.queryByRole('list', { name: 'Agentes fijados' })).toBeNull();
  });

  it('collapses a group and persists the choice', async () => {
    const user = userEvent.setup();
    renderSidebar(true);
    await user.click(screen.getByRole('button', { name: 'Gobernanza' }));
    expect(screen.getByRole('button', { name: 'Gobernanza' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('link', { name: 'Audit log' })).toBeNull();
    expect(window.localStorage.getItem('mango-sb-groups')).toBe('{"gov":false}');
  });

  it('re-expands a collapsed group when navigating to one of its pages', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('mango-sb-groups', '{"gov":false}');
    function GoToBudgets() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => void navigate('/budgets')}>
          go
        </button>
      );
    }
    render(
      <TestProviders session={sessionValue({ me: { ...baseMe, is_admin: true } })} path="/">
        <Sidebar
          mode="full"
          collapsed={false}
          onToggleCollapsed={() => undefined}
          onNavigate={() => undefined}
        />
        <GoToBudgets />
      </TestProviders>,
    );
    expect(screen.getByRole('button', { name: 'Gobernanza' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await user.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByRole('button', { name: 'Gobernanza' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Presupuestos' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('ignores a malformed stored group state', () => {
    window.localStorage.setItem('mango-sb-groups', '{"gov":"<img>"');
    renderSidebar(true);
    expect(screen.getByRole('link', { name: 'Audit log' })).toBeInTheDocument();
  });

  it('marks the active destination with aria-current, chat included for /c/:id', () => {
    renderSidebar(true, '/audit');
    expect(screen.getByRole('link', { name: 'Audit log' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Chat' })).not.toHaveAttribute('aria-current');

    renderSidebar(false, '/c/01J0000000000000000000000');
    expect(screen.getAllByRole('link', { name: 'Chat' }).at(-1)).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

function renderRail(
  path = '/',
  { toSign = null, agents }: { toSign?: number | null; agents?: Agent[] } = {},
) {
  const me: Me = { ...baseMe, is_admin: true };
  return render(
    <TestProviders
      session={sessionValue({ me, ...(agents ? { agents } : {}) })}
      path={path}
      toSign={toSign}
    >
      <Sidebar mode="full" collapsed onToggleCollapsed={noop} onNavigate={noop} />
    </TestProviders>,
  );
}

const railGroup = (name: RegExp) => screen.getByRole('button', { name });

/** Moves the fake clock inside act, so the timers' state updates are flushed. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('Sidebar · collapsed rail (design 2026-10-25)', () => {
  it('shows the main views and pinned agents, and one icon per group instead of its views', () => {
    renderRail();
    expect(navLinks()).toEqual(['Chat', 'Bandeja', 'Marketplace', 'Chat con FinOps']);
    for (const name of ['Gobernanza', 'Construir', 'Operación']) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveAttribute('aria-haspopup', 'menu');
      expect(button).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('marks the group that holds the current view and the view inside its menu', async () => {
    const user = userEvent.setup();
    renderRail('/audit');
    const gov = railGroup(/^Gobernanza/);
    expect(gov).toHaveAccessibleName('Gobernanza, contiene la vista actual');
    expect(gov).toHaveClass('is-current');
    expect(railGroup(/^Construir/)).not.toHaveClass('is-current');
    await user.click(gov);
    const menu = screen.getByRole('menu', { name: 'Gobernanza' });
    expect(gov).toHaveAttribute('aria-expanded', 'true');
    expect(gov).toHaveAttribute('aria-controls', menu.id);
    const current = within(menu).getByRole('menuitem', { name: 'Audit log, vista actual' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current).toHaveAttribute('href', '/audit');
  });

  it('shows a dot when there is something to sign, with its count in the menu', async () => {
    const user = userEvent.setup();
    const { container } = renderRail('/', { toSign: 2 });
    const gov = railGroup(/^Gobernanza/);
    expect(gov).toHaveAccessibleName('Gobernanza, 2 pendientes');
    expect(gov.querySelector('.sb-dot-badge')).not.toBeNull();
    expect(railGroup(/^Construir/).querySelector('.sb-dot-badge')).toBeNull();
    await user.click(gov);
    expect(screen.getByRole('menuitem', { name: 'Aprobaciones (2)' })).toHaveAttribute(
      'href',
      '/approvals',
    );
    expect(container.querySelectorAll('.sb-dot-badge')).toHaveLength(1);
  });

  it('lists «Próximamente» views as disabled items that do not navigate', async () => {
    const user = userEvent.setup();
    renderRail();
    await user.click(railGroup(/^Construir/));
    const soon = screen.getByRole('menuitem', { name: 'Skills, próximamente' });
    expect(soon).toHaveAttribute('aria-disabled', 'true');
    expect(soon).not.toHaveAttribute('href');
    expect(within(soon).getByText('Próximamente')).toBeInTheDocument();
  });

  it('opens on hover after 120 ms and closes 220 ms after the pointer leaves, unless clicked', () => {
    vi.useFakeTimers();
    try {
      renderRail();
      const gov = railGroup(/^Gobernanza/);
      const wrapper = gov.parentElement as HTMLElement;
      fireEvent.mouseEnter(wrapper);
      advance(100);
      expect(screen.queryByRole('menu')).toBeNull();
      advance(20);
      expect(screen.getByRole('menu', { name: 'Gobernanza' })).toBeInTheDocument();
      fireEvent.mouseLeave(wrapper);
      advance(200);
      expect(screen.getByRole('menu')).toBeInTheDocument();
      advance(20);
      expect(screen.queryByRole('menu')).toBeNull();
      // A click keeps it open; another click, or a click outside, closes it.
      fireEvent.click(gov);
      fireEvent.mouseLeave(wrapper);
      advance(500);
      expect(screen.getByRole('menu')).toBeInTheDocument();
      fireEvent.click(gov);
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.click(gov);
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('works with the keyboard: opens on the first view, moves, Esc returns the focus, Tab closes', async () => {
    const user = userEvent.setup();
    renderRail();
    const gov = railGroup(/^Gobernanza/);
    gov.focus();
    await user.keyboard('{Enter}');
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items[0]).toHaveAccessibleName('Aprobaciones');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items.at(-1)).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(items.at(-1)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(gov).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.tab();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens one menu at a time, and choosing a view closes it', async () => {
    const user = userEvent.setup();
    renderRail();
    await user.click(railGroup(/^Gobernanza/));
    await user.click(railGroup(/^Operación/));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    await user.click(screen.getByRole('menuitem', { name: 'Org Chart' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows up to 4 pinned agents; past that, 3 and «Más agentes fijados» with the rest', async () => {
    const user = userEvent.setup();
    const extra = ['a', 'b', 'c', 'd'].map((letter, index) =>
      agentFixture({ id: letter.repeat(16), name: `Agente ${String(index + 1)}` }),
    );
    window.localStorage.setItem(
      'mango-pinned-agents',
      JSON.stringify(['finops', ...extra.map((agent) => agent.id)]),
    );
    renderRail('/', { agents: [finopsAgent, ...extra] });
    const pinned = screen.getByRole('list', { name: 'Agentes fijados' });
    expect(
      within(pinned)
        .getAllByRole('link')
        .map((link) => link.getAttribute('aria-label')),
    ).toEqual(['Chat con FinOps', 'Chat con Agente 1', 'Chat con Agente 2']);
    const more = within(pinned).getByRole('button', { name: 'Más agentes fijados (2)' });
    await user.click(more);
    const menu = screen.getByRole('menu', { name: 'Agentes fijados' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.getAttribute('href')),
    ).toEqual([`/?agent=${'c'.repeat(16)}`, `/?agent=${'d'.repeat(16)}`]);
  });

  it('keeps exactly 4 pinned agents in the rail without the extra menu', () => {
    const extra = ['a', 'b', 'c'].map((letter) =>
      agentFixture({ id: letter.repeat(16), name: letter }),
    );
    window.localStorage.setItem(
      'mango-pinned-agents',
      JSON.stringify(['finops', ...extra.map((agent) => agent.id)]),
    );
    renderRail('/', { agents: [finopsAgent, ...extra] });
    const pinned = screen.getByRole('list', { name: 'Agentes fijados' });
    expect(within(pinned).getAllByRole('link')).toHaveLength(4);
    expect(within(pinned).queryByRole('button')).toBeNull();
  });

  it('shows floating titles instead of `title`, hidden while a menu is open or on scroll', async () => {
    const user = userEvent.setup();
    const { container } = renderRail();
    const bandeja = screen.getByRole('link', { name: 'Bandeja' });
    expect(bandeja).not.toHaveAttribute('title');
    await user.hover(bandeja);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Bandeja');
    expect(screen.getByRole('button', { name: 'Expandir sidebar' })).toHaveAttribute(
      'data-tip',
      'Expandir',
    );
    fireEvent.scroll(container.querySelector('.sb-nav') as Element);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.hover(bandeja);
    await user.click(railGroup(/^Gobernanza/));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
