import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MemorySection } from './MemorySection';
import { SECTION_IDS, toInput } from './model';
import { context, definition } from './testFixtures';

describe('MemorySection (design round 41, D122)', () => {
  it('turns «Recuerda entre conversaciones» on and off in the version', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<MemorySection memory={false} memoryEnabled onChange={onChange} />);
    const box = screen.getByRole('button', { name: /Recuerda entre conversaciones/ });
    expect(box).toHaveAttribute('aria-pressed', 'false');
    await user.click(box);
    expect(onChange).toHaveBeenLastCalledWith({ memory: true });
    rerender(<MemorySection memory memoryEnabled onChange={onChange} />);
    expect(box).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/apagada en esta instalación/)).not.toBeInTheDocument();
  });

  it('says the box is kept but nothing is remembered while the installation has it off', () => {
    render(<MemorySection memory memoryEnabled={false} onChange={vi.fn()} />);
    expect(
      screen.getByText(
        'La memoria está apagada en esta instalación: la casilla se guarda en la versión, pero el agente no recordará nada hasta que se encienda.',
      ),
    ).toBeInTheDocument();
  });

  it('goes right after «Ejecutar código» and is sent with the version', () => {
    expect(SECTION_IDS.indexOf('memory')).toBe(SECTION_IDS.indexOf('code') + 1);
    expect(toInput(definition({ memory: true }), context, '').memory).toBe(true);
  });
});
