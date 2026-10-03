import { act, render, screen } from '@testing-library/react';
import { useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRoutes } from './App';
import { baseMe, sessionValue } from './test/fixtures';
import { TestProviders } from './test/TestProviders';

function CurrentPath() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}

async function renderAt(path: string, isAdmin = true) {
  render(
    <TestProviders session={sessionValue({ me: { ...baseMe, is_admin: isAdmin } })} path={path}>
      <AppRoutes />
      <CurrentPath />
    </TestProviders>,
  );
  // Let lazy routes settle.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AppRoutes', () => {
  it.each([
    ['/dashboard', 'Inicio'],
    ['/tickets/MNG-1', 'Tickets'],
  ])('renders %s as "Próximamente"', async (path, label) => {
    await renderAt(path);
    // Screen pages load on demand.
    expect(await screen.findByRole('heading', { level: 1, name: label })).toBeInTheDocument();
    expect(screen.getByText('Esta sección todavía no está disponible en Mango.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Ir al chat' })).toHaveAttribute('href', '/');
  });

  it.each(['/admin', '/admin/k3fq7zr2m5xw6n4a/3'])(
    'renders the Agent Builder at %s',
    async (path) => {
      await renderAt(path);
      // Its own lazy page; this account has no permission to create agents.
      expect(
        await screen.findByRole('heading', { level: 1, name: 'No puedes crear agentes' }),
      ).toBeInTheDocument();
    },
  );

  it.each([
    ['/admin/audit', '/audit'],
    ['/admin/budgets', '/budgets'],
    ['/admin/settings', '/settings'],
    ['/chat', '/'],
    ['/chat/01J0000000000000000000000', '/c/01J0000000000000000000000'],
  ])('redirects %s to %s', async (from, to) => {
    await renderAt(from);
    expect(screen.getByTestId('path')).toHaveTextContent(new RegExp(`^${to}$`));
  });

  it('shows the not-found page for unknown paths', async () => {
    await renderAt('/does-not-exist');
    expect(screen.getByRole('heading', { name: 'Página no encontrada' })).toBeInTheDocument();
    // Design system.jsx ErrorState kind="notfound": secondary button, text only.
    const back = screen.getByRole('link', { name: 'Volver al chat' });
    expect(back).toHaveAttribute('href', '/');
    expect(back).toHaveClass('btn', 'btn-sm');
    expect(back).not.toHaveClass('btn-primary');
    expect(back.querySelector('svg')).toBeNull();
  });
});
