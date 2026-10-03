import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useNavigate } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import type { Me } from '../api/schemas';
import { agentFixture, baseMe, finopsAgent, sessionValue } from '../test/fixtures';
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
    await user.click(screen.getByRole('button', { name: 'Operación' }));
    expect(navLinks()).toEqual([
      'Chat',
      'Marketplace',
      'Chat con FinOps',
      'Aprobaciones',
      'Org Chart',
    ]);
    expect(soonItems()).toEqual([
      'Inicio, próximamente',
      'Bandeja, próximamente',
      'Tickets, próximamente',
      'Buscar conversaciones, próximamente',
      'Actividad, próximamente',
    ]);
    // Construir has no user views; admin screens and the Catálogo de MCP are hidden.
    expect(screen.getByRole('button', { name: 'Gobernanza' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Construir' })).toBeNull();
    expect(screen.queryByText('Catálogo de MCP')).toBeNull();
    expect(screen.queryByText('Audit log')).toBeNull();
    expect(screen.queryByText('Presupuestos')).toBeNull();
  });

  it('also shows the owner views to FinOps central without Admin (S1)', async () => {
    const user = userEvent.setup();
    renderSidebar(false, '/', false, 'finops-central');
    await user.click(screen.getByRole('button', { name: 'Construir' }));
    await user.click(screen.getByRole('button', { name: 'Operación' }));
    // Of the owner views, the Org Chart is available (read only; the API filters it, D38) and the Marketplace.
    expect(navLinks()).toEqual([
      'Chat',
      'Marketplace',
      'Chat con FinOps',
      'Aprobaciones',
      'Org Chart',
    ]);
    expect(soonItems()).toEqual([
      'Inicio, próximamente',
      'Bandeja, próximamente',
      'Tickets, próximamente',
      'Buscar conversaciones, próximamente',
      'Gobernanza, próximamente',
      'Actividad, próximamente',
      'Playground, próximamente',
      'Skills, próximamente',
      'Knowledge Bases, próximamente',
      'Schedules, próximamente',
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

  it('keeps every destination labelled in the collapsed rail, without group headers', () => {
    renderSidebar(true, '/', true);
    expect(navLinks()).toEqual([
      'Chat',
      'Marketplace',
      'Chat con FinOps',
      'Aprobaciones',
      'Revisión de agentes',
      'Presupuestos',
      'Audit log',
      'Brains',
      'Catálogo de MCP',
      'Org Chart',
    ]);
    expect(soonItems()).toContain('Playground, próximamente');
    expect(screen.queryByRole('button', { name: 'Gobernanza' })).toBeNull();
    expect(screen.queryByText('Próximamente')).toBeNull();
  });
});
