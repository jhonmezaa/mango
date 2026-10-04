import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthContext } from '../auth/AuthContext';
import { authValue } from '../test/fixtures';
import { SessionWarning } from './SessionWarning';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const MIN = 60_000;

function renderWarning(sessionEndsAt: number | null) {
  return render(
    <AuthContext value={authValue({ sessionEndsAt })}>
      <SessionWarning />
    </AuthContext>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SessionWarning', () => {
  it('shows nothing until ten minutes before the session ends', () => {
    renderWarning(NOW + 60 * MIN);
    expect(screen.queryByText(/Tu sesión vence/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(49 * MIN);
    });
    expect(screen.queryByText(/Tu sesión vence/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(MIN);
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Tu sesión vence en 10 min. Guarda lo que estés escribiendo: al vencer vuelves a ingresar con tu contraseña y MFA.',
    );
  });

  it('is shown once: «Entendido» hides it', () => {
    renderWarning(NOW + 60 * MIN);
    act(() => {
      vi.advanceTimersByTime(50 * MIN);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Entendido' }));
    expect(screen.queryByText(/Tu sesión vence/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(5 * MIN);
    });
    expect(screen.queryByText(/Tu sesión vence/)).toBeNull();
  });

  it('says the minutes left when the page opens with less than ten', () => {
    renderWarning(NOW + 4 * MIN);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Tu sesión vence en 4 min.');
  });

  it('shows nothing when the end of the session is unknown or already passed', () => {
    const { unmount } = renderWarning(null);
    act(() => {
      vi.advanceTimersByTime(24 * 60 * MIN);
    });
    expect(screen.queryByText(/Tu sesión vence/)).toBeNull();
    unmount();
    renderWarning(NOW - MIN);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.queryByText(/Tu sesión vence/)).toBeNull();
  });
});
