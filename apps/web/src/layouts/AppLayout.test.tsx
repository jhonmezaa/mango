import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionContextValue } from '../auth/SessionContext';
import { Topbar } from '../components/Topbar';
import { agentFixture, baseMe, finopsAgent, sessionValue } from '../test/fixtures';
import { TestProviders } from '../test/TestProviders';
import { AppLayout } from './AppLayout';

// Controllable matchMedia: `width` drives the (max-width: N px) queries used by the layout.
let width = 1440;
const listeners = new Set<() => void>();

function setWidth(next: number) {
  width = next;
  act(() => {
    for (const listener of listeners) listener();
  });
}

beforeEach(() => {
  width = 1440;
  listeners.clear();
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      get matches() {
        return max ? width <= Number(max[1]) : false;
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    } as unknown as MediaQueryList;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function CurrentPath() {
  const { pathname, search } = useLocation();
  return (
    <output data-testid="path">
      {pathname}
      {search}
    </output>
  );
}

function renderLayout(isAdmin = true, session: Partial<SessionContextValue> = {}) {
  render(
    <TestProviders session={sessionValue({ me: { ...baseMe, is_admin: isAdmin }, ...session })}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Topbar crumbs={['Chat']} />} />
          <Route path="settings" element={<Topbar crumbs={['Ajustes']} />} />
        </Route>
      </Routes>
      <CurrentPath />
    </TestProviders>,
  );
}

const drawerOpen = () => document.querySelector('.sidebar')?.classList.contains('open') ?? false;

describe('AppLayout', () => {
  it('Escape in the account menu closes only the menu, not the mobile drawer', async () => {
    const user = userEvent.setup();
    setWidth(420);
    renderLayout();
    await user.click(screen.getByRole('button', { name: 'Abrir menú' }));
    expect(drawerOpen()).toBe(true);

    await user.click(screen.getByRole('button', { name: /Cuenta de/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(drawerOpen()).toBe(true);

    await user.keyboard('{Escape}');
    expect(drawerOpen()).toBe(false);
  });

  it('closes the mobile drawer when leaving the breakpoint, so it does not reopen', async () => {
    const user = userEvent.setup();
    setWidth(420);
    renderLayout();
    await user.click(screen.getByRole('button', { name: 'Abrir menú' }));
    expect(drawerOpen()).toBe(true);

    setWidth(1440);
    setWidth(420);
    expect(drawerOpen()).toBe(false);
  });

  it('persists the collapsed sidebar state', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole('button', { name: 'Colapsar sidebar' }));
    expect(window.localStorage.getItem('mango-sb-collapsed')).toBe('1');
    await user.click(screen.getByRole('button', { name: 'Expandir sidebar' }));
    expect(window.localStorage.getItem('mango-sb-collapsed')).toBe('0');
  });

  it('shows the topbar of the design: search "Próximamente", Ajustes and new conversation', async () => {
    const user = userEvent.setup();
    renderLayout();
    const banner = screen.getByRole('banner');
    expect(banner).toHaveTextContent('Buscar');
    expect(banner).toHaveTextContent('⌘K');
    expect(banner).toHaveTextContent('Próximamente');
    // The dimmed search is inert: not a button, only announced as "próximamente".
    expect(screen.queryByRole('button', { name: /Buscar/ })).toBeNull();
    expect(screen.getByText('Buscar, próximamente')).toHaveClass('sr-only');
    // Help and the approvals bell are hidden in the current-availability mode.
    expect(screen.queryByRole('button', { name: 'Ayuda' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Aprobaciones pendientes/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Ajustes' }));
    expect(screen.getByTestId('path')).toHaveTextContent('/settings');
    // A single agent to talk to: nothing to pick, its chat opens.
    await user.click(screen.getByRole('button', { name: 'Nueva conversación' }));
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/\?agent=finops$/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks which agent to talk to when there are several (design AgentPicker)', async () => {
    const user = userEvent.setup();
    const sales = agentFixture({ id: 'abcdefghijklmnop', name: 'Ventas', category: 'Comercial' });
    renderLayout(true, {
      agents: [finopsAgent, sales],
      conversations: [
        {
          conversation_id: 'c1',
          title: 't',
          updated_at: '2026-09-30T10:00:00Z',
          agent_id: sales.id,
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Ajustes' }));
    await user.click(screen.getByRole('button', { name: 'Nueva conversación' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva conversación' });
    expect(within(dialog).getByRole('region', { name: 'Recientes' })).toHaveTextContent('Ventas');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('path')).toHaveTextContent('/settings');

    await user.click(screen.getByRole('button', { name: 'Nueva conversación' }));
    const picker = await screen.findByRole('dialog', { name: 'Nueva conversación' });
    const [card] = within(picker).getAllByRole('button', { name: /Ventas/ });
    if (!card) throw new Error('no card');
    await user.click(card);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/\?agent=abcdefghijklmnop$/);
  });

  it('opens the Agent Builder from the picker for who may create agents', async () => {
    const user = userEvent.setup();
    const sales = agentFixture({ id: 'abcdefghijklmnop', name: 'Ventas' });
    renderLayout(true, {
      agents: [finopsAgent, sales],
      me: { ...baseMe, is_admin: true, can: { create_agent: true } },
    });
    await user.click(screen.getByRole('button', { name: 'Nueva conversación' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva conversación' });
    await user.click(within(dialog).getByRole('button', { name: 'Crear nuevo agente' }));
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/admin$/);
  });

  it('pins an agent for the sidebar and keeps it across reloads', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole('button', { name: 'Quitar FinOps de fijados' }));
    expect(screen.queryByRole('list', { name: 'Agentes fijados' })).toBeNull();
    expect(window.localStorage.getItem('mango-pinned-agents')).toBe('[]');
  });

  it('shows the Ajustes gear only to admins (v9)', () => {
    renderLayout(false);
    const banner = screen.getByRole('banner');
    expect(within(banner).queryByRole('button', { name: 'Ajustes' })).toBeNull();
    expect(within(banner).getByRole('button', { name: 'Nueva conversación' })).toBeInTheDocument();
  });
});
