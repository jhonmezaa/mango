import { describe, expect, it } from 'vitest';

import { appendPage, durationWidth, formatMs, kindOf, shortId, spanBar, type Trace } from './model';

const base = {
  matched: true,
  playground: false,
  origin: 'chat',
} as const;
const asTrace = (fields: Partial<Trace>) => ({ ...base, ...fields }) as Trace;

describe('observability model', () => {
  it('formats durations as the design', () => {
    expect(formatMs(820.4)).toBe('820 ms');
    expect(formatMs(4230)).toBe('4,2 s');
    expect(formatMs(74_000)).toBe('74 s');
  });

  it('shows the first eight characters of the id', () => {
    expect(shortId('0123456789abcdef'.repeat(2))).toBe('01234567');
  });

  it('says what a trace was', () => {
    expect(kindOf(asTrace({}))).toBe('chat');
    expect(kindOf(asTrace({ origin: 'task' }))).toBe('task');
    expect(kindOf(asTrace({ playground: true }))).toBe('playground');
    expect(kindOf(asTrace({ origin: 'playground' }))).toBe('playground');
    expect(kindOf(asTrace({ matched: false, origin: null }))).toBe('unmatched');
  });

  it('keeps a span of the waterfall inside its trace', () => {
    const span = {
      kind: 'tool',
      name: 'x',
      offset_ms: 900,
      duration_ms: 400,
      failed: false,
      input_tokens: null,
      output_tokens: null,
    } as const;
    expect(spanBar(span, 1000)).toEqual({ left: 90, width: 10 });
    expect(spanBar({ ...span, offset_ms: 0, duration_ms: 1 }, 1000).width).toBe(0.8);
    expect(spanBar(span, 0)).toEqual({ left: 0, width: 100 });
  });

  it('draws the p95 at 80 % of the mini bar and never past 100 %', () => {
    expect(durationWidth(1000, 1000)).toBe(80);
    expect(durationWidth(5000, 1000)).toBe(100);
    expect(durationWidth(10, null)).toBe(100);
  });

  it('appends a page without repeating a trace', () => {
    const a = asTrace({ id: 'a' });
    const b = asTrace({ id: 'b' });
    expect(appendPage([a], [a, b]).map((trace) => trace.id)).toEqual(['a', 'b']);
  });
});
