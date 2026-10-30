import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BootScreen } from './BootScreen';

afterEach(() => {
  vi.useRealTimers();
});

describe('BootScreen (design round 27, «Recargar la página»)', () => {
  it('paints the app frame with skeletons when this browser had a session, with no text', () => {
    const { container } = render(<BootScreen had />);
    const frame = screen.getByRole('progressbar', { name: 'Cargando Mango' });
    expect(frame).toHaveClass('boot-app');
    expect(frame).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.boot-sb .boot-row')).toHaveLength(8);
    expect(container.querySelector('.boot-compose')).not.toBeNull();
    // Only the logo letter: no «Recuperando tu sesión…», no form.
    expect(frame).toHaveTextContent(/^m$/);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('paints the neutral cover when it did not', () => {
    render(<BootScreen had={false} />);
    const cover = screen.getByRole('progressbar', { name: 'Cargando Mango' });
    expect(cover).toHaveClass('boot-cover');
    expect(cover.querySelector('.boot-logo')).not.toBeNull();
    expect(cover.querySelector('.boot-sb')).toBeNull();
  });

  it('adds the thin bar only when the wait is long (1,2 s)', () => {
    vi.useFakeTimers();
    const { container } = render(<BootScreen had />);
    act(() => {
      vi.advanceTimersByTime(1199);
    });
    expect(container.querySelector('.boot-bar')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector('.boot-bar')).toHaveAttribute('aria-hidden', 'true');
  });
});
