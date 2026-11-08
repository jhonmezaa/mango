import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CodeSection } from './CodeSection';
import { SECTION_IDS } from './model';

describe('CodeSection (design round 40, D114 (6))', () => {
  it('turns «Puede ejecutar código» on and off as a capability of the version', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<CodeSection capabilities={[]} onChange={onChange} />);
    const box = screen.getByRole('button', { name: /Puede ejecutar código/ });
    expect(box).toHaveAttribute('aria-pressed', 'false');
    await user.click(box);
    expect(onChange).toHaveBeenLastCalledWith({ capabilities: ['code_interpreter'] });
    rerender(<CodeSection capabilities={['code_interpreter']} onChange={onChange} />);
    expect(box).toHaveAttribute('aria-pressed', 'true');
    await user.click(box);
    expect(onChange).toHaveBeenLastCalledWith({ capabilities: [] });
  });

  it('goes right after Knowledge bases', () => {
    expect(SECTION_IDS.indexOf('code')).toBe(SECTION_IDS.indexOf('kbs') + 1);
  });
});
