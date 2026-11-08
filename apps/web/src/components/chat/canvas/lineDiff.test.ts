import { describe, expect, it } from 'vitest';

import { lineDiff } from './lineDiff';

describe('lineDiff (design round 41)', () => {
  it('keeps the shared lines and marks what was added and removed', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      [' ', 'a'],
      ['+', 'B'],
      ['-', 'b'],
      [' ', 'c'],
      ['+', 'd'],
    ]);
  });

  it('says nothing changed for the same text', () => {
    expect(lineDiff('x\ny', 'x\ny').every(([kind]) => kind === ' ')).toBe(true);
  });

  it('handles lines that moved', () => {
    const out = lineDiff('a\nb', 'b\na');
    expect(out.filter(([k]) => k === '+').length).toBe(out.filter(([k]) => k === '-').length);
  });
});
