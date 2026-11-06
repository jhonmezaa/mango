import { describe, expect, it } from 'vitest';

import { costsFixture } from './fixture';
import {
  change,
  coversMonth,
  coversPrevious,
  cumulative,
  formatDay,
  formatMonth,
  kmoney,
  linesOf,
  money,
  moversOf,
  toCsv,
} from './model';

const labels = {
  header: 'agente,modelo,gasto_mes,mes_anterior,consultas',
  noAgent: 'Sin agente',
  pre: 'Sin desglose',
  noBreakdown: 'sin desglose',
  nameOf: (row: { name: string | null; id: string }) => row.name ?? row.id,
};

describe('Costos model · design round 37', () => {
  it('compares with the month before only when the breakdown counted all of it', () => {
    const data = costsFixture();
    expect(coversPrevious('2026-10-01', data)).toBe(true);
    expect(coversPrevious('2026-10-02', data)).toBe(false);
    expect(coversPrevious(null, data)).toBe(false);
    expect(coversMonth('2026-11-01', data)).toBe(true);
    expect(coversMonth('2026-11-12', data)).toBe(false);
  });

  it('per agent: rows by spend, then «Sin agente» even at zero', () => {
    const lines = linesOf(costsFixture(), 'agent');
    expect(lines.map((l) => [l.kind, l.id, l.spent, l.previous])).toEqual([
      ['row', 'finops', 6, 4],
      ['row', 'legal', 3.9, 5],
      ['none', 'none', 0.1, null],
    ]);
    const empty = costsFixture();
    empty.agents.unattributed_usd = '0.00';
    expect(linesOf(empty, 'agent').at(-1)).toMatchObject({ kind: 'none', spent: 0 });
  });

  it('per agent: the Playground and an agent no longer in the catalog are grey, at the end', () => {
    const data = costsFixture();
    const [first] = data.agents.rows;
    if (!first) throw new Error('fixture');
    data.agents.rows.push(
      { ...first, id: 'playground', name: null, spent_usd: '9.00', budget: null },
      { ...first, id: 'gone', name: null, spent_usd: '0.50', budget: null },
    );
    expect(linesOf(data, 'agent').map((l) => [l.kind, l.id, l.previous, l.open])).toEqual([
      ['row', 'finops', 4, true],
      ['row', 'legal', 5, true],
      ['aside', 'playground', null, false],
      ['aside', 'gone', null, false],
      ['none', 'none', null, false],
    ]);
  });

  it('per model and origin: before the counters apart from the titles, never spread', () => {
    const models = linesOf(costsFixture(), 'model');
    expect(models.map((l) => [l.kind, l.spent, l.previous])).toEqual([
      ['row', 5.9, null],
      ['none', expect.closeTo(0.1, 5), null],
      ['pre', 4, null],
    ]);
    // The design's order and only origins with spend.
    expect(linesOf(costsFixture(), 'source').map((l) => l.id)).toEqual([
      'chat',
      'task',
      'none',
      'pre',
    ]);
  });

  it('movers only with a breakdown of the month before', () => {
    expect(moversOf(costsFixture())?.map((m) => [m.row.id, m.delta])).toEqual([
      ['finops', 2],
      ['legal', expect.closeTo(-1.1, 5)],
    ]);
    const late = costsFixture();
    late.agents.counted_since = '2026-10-20';
    expect(moversOf(late)).toBeNull();
  });

  it('formats as the design', () => {
    expect(money(1234.5)).toBe('USD 1.234,50');
    expect(kmoney(12_345)).toBe('USD 12,3k');
    expect(kmoney(999)).toBe('USD 999,00');
    expect(formatDay('2026-10-05')).toMatch(/^5 oct\.? 2026$/);
    expect(formatMonth('2026-11')).toBe('noviembre de 2026');
    expect(cumulative([{ spent_usd: '1' }, { spent_usd: '2.5' }])).toEqual([1, 3.5]);
    expect(change(12, 10)).toBeCloseTo(20);
    expect(change(12, 0)).toBeNull();
    expect(change(12, null)).toBeNull();
  });

  it('exports the CSV with «Sin agente» and «Sin desglose», formulas neutralized', () => {
    const data = costsFixture();
    data.agents.unattributed_usd = '0.60';
    data.agents.before_since_usd = '0.50';
    const csv = toCsv(data, labels).split('\n');
    expect(csv[0]).toBe('agente,modelo,gasto_mes,mes_anterior,consultas');
    expect(csv[1]).toBe('"FinOps","us.anthropic.claude-sonnet-4-6","6.00","4.00","120"');
    expect(csv[2]).toBe(`"'=HYPERLINK(""x"")","us.anthropic.claude-sonnet-4-6","3.90","5.00","70"`);
    expect(csv[3]).toBe('"Sin agente","","0.10","sin desglose",""');
    expect(csv[4]).toBe('"Sin desglose","","0.50","",""');
    const late = costsFixture();
    late.agents.counted_since = '2026-10-20';
    expect(toCsv(late, labels).split('\n')[1]).toContain('"sin desglose"');
  });
});
