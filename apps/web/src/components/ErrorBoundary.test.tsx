import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { TestProviders } from '../test/TestProviders';
import { ErrorBoundary } from './ErrorBoundary';

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error('<img src=x onerror=alert(1)> boom');
  return <p>contenido</p>;
}

function Harness() {
  const [explode, setExplode] = useState(true);
  const [path, setPath] = useState('/admin/settings');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setExplode(false);
        }}
      >
        fix
      </button>
      <button
        type="button"
        onClick={() => {
          setPath('/');
        }}
      >
        navigate
      </button>
      <ErrorBoundary resetKey={path}>
        <Bomb explode={explode} />
      </ErrorBoundary>
    </>
  );
}

describe('ErrorBoundary', () => {
  it('shows the crash state without the error text, with Recargar and Ir al chat', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    const user = userEvent.setup();
    const { container } = render(
      <TestProviders>
        <Harness />
      </TestProviders>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Algo se rompió en esta vista');
    expect(alert).toHaveTextContent(
      'Ocurrió un error inesperado. Recarga la página o vuelve al chat.',
    );
    expect(alert).toHaveTextContent('RENDER_ERROR');
    expect(container).not.toHaveTextContent('boom');
    expect(container.querySelector('img')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Recargar' }));
    expect(reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();

    await user.click(screen.getByRole('button', { name: 'fix' }));
    await user.click(screen.getByRole('link', { name: 'Ir al chat' }));
    expect(screen.getByText('contenido')).toBeInTheDocument();
  });

  it('recovers when the route changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(
      <TestProviders>
        <Harness />
      </TestProviders>,
    );
    await user.click(screen.getByRole('button', { name: 'fix' }));
    await user.click(screen.getByRole('button', { name: 'navigate' }));
    expect(screen.getByText('contenido')).toBeInTheDocument();
  });
});
