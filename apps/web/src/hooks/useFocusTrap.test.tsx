import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type KeyboardEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useFocusTrap } from './useFocusTrap';

function Harness({ onEscape }: { onEscape: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useFocusTrap<HTMLDivElement>(open, () => {
    onEscape();
    setOpen(false);
  });
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        open
      </button>
      {open && (
        <div ref={ref} role="dialog" aria-label="trap">
          <button type="button">first</button>
          <button type="button" data-autofocus>
            second
          </button>
          <input
            aria-label="nested"
            onKeyDown={(event: KeyboardEvent) => {
              // A nested widget that handles Escape itself.
              if (event.key === 'Escape') event.preventDefault();
            }}
          />
        </div>
      )}
    </>
  );
}

describe('useFocusTrap', () => {
  it('focuses the autofocus element, cycles Tab inside and restores focus on close', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    const opener = screen.getByRole('button', { name: 'open' });
    await user.click(opener);

    expect(screen.getByRole('button', { name: 'second' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'nested' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('textbox', { name: 'nested' })).toHaveFocus();

    screen.getByRole('button', { name: 'first' }).focus();
    await user.keyboard('{Escape}');
    expect(onEscape).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('ignores Escape already handled (defaultPrevented) by a nested widget', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    await user.click(screen.getByRole('button', { name: 'open' }));
    await user.click(screen.getByRole('textbox', { name: 'nested' }));
    await user.keyboard('{Escape}');
    expect(onEscape).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
