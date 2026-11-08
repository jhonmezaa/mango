import { describe, expect, it } from 'vitest';

import {
  chartTsv,
  formatCell,
  formatValue,
  MAX_ROWS,
  MAX_SERIES,
  normalizeChart,
  parseChartBlock,
  tsvCell,
} from './chartSpec';

function must<T>(value: T | null): T {
  if (value === null) throw new Error('expected a spec');
  return value;
}

const BARS = {
  chartType: 'bar',
  xKey: 'mes',
  series: [{ key: 'EC2', label: 'EC2' }, { key: 'S3' }],
  meta: { title: 'Costo mensual por servicio', subtitle: 'may – oct 2026 · USD' },
  axes: { y: { label: 'USD' } },
  data: [
    { mes: 'may', EC2: 41200, S3: 12800 },
    { mes: 'jun', EC2: 42900, S3: 13100 },
  ],
};

describe('the closed spec of a chart (D118 (1), the server`s parse_chart)', () => {
  it('keeps a full spec and fills in every default', () => {
    const spec = normalizeChart(BARS);
    expect(spec).not.toBeNull();
    expect(spec?.series).toEqual([
      {
        key: 'EC2',
        label: 'EC2',
        valueFormat: 'compact',
        valuePrefix: '',
        valueSuffix: '',
        stack: null,
      },
      {
        key: 'S3',
        label: 'S3',
        valueFormat: 'compact',
        valuePrefix: '',
        valueSuffix: '',
        stack: null,
      },
    ]);
    expect(spec?.axes).toEqual({ x: { label: null }, y: { label: 'USD' } });
    expect(spec?.layout).toBe('horizontal');
    expect(spec?.meta.title).toBe('Costo mensual por servicio');
  });

  it('takes the first text column as x and the first number as the series', () => {
    const spec = normalizeChart({ chartType: 'line', data: [{ v: 3, mes: 'may' }] });
    expect(spec?.xKey).toBe('mes');
    expect(spec?.series.map((s) => s.key)).toEqual(['v']);
  });

  it('ignores unknown fields and falls back on invalid ones', () => {
    const spec = normalizeChart({
      ...BARS,
      html: '<script>alert(1)</script>',
      valueFormat: 'currency',
      layout: 'diagonal',
      meta: { title: '  ', description: 'del formato que copia' },
      series: [{ dataKey: 'EC2', valueFormat: 7 }, { key: '' }, 'S3', null],
    });
    expect(spec?.valueFormat).toBe('compact');
    expect(spec?.layout).toBe('horizontal');
    expect(spec?.meta).toEqual({ title: null, subtitle: 'del formato que copia', footer: null });
    expect(spec?.series.map((s) => s.key)).toEqual(['EC2']);
    expect(JSON.stringify(spec)).not.toContain('script');
  });

  it('keeps only plain values in the rows', () => {
    const spec = normalizeChart({
      chartType: 'scatter',
      xKey: 'cpu',
      data: [{ cpu: 4, costo: Infinity, nota: { a: 1 }, ok: true, id: 'x'.repeat(500) }, 'x', {}],
    });
    expect(spec?.data).toEqual([
      { cpu: 4, costo: null, nota: null, ok: true, id: 'x'.repeat(200) },
    ]);
  });

  it('drops the keys that would reach a prototype', () => {
    const spec = normalizeChart(
      JSON.parse(
        '{"chartType": "bar", "xKey": "__proto__", "series": [{"key": "constructor"}, {"key": "v"}],' +
          ' "data": [{"__proto__": {"polluted": 1}, "prototype": 1, "mes": "may", "v": 2}]}',
      ),
    );
    expect(spec?.data).toEqual([{ mes: 'may', v: 2 }]);
    expect(spec?.xKey).toBe('mes');
    expect(spec?.series.map((s) => s.key)).toEqual(['v']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    null,
    'bar',
    [],
    { data: BARS.data },
    { ...BARS, chartType: 'radar' },
    { ...BARS, data: [] },
    { ...BARS, data: Array.from({ length: MAX_ROWS + 1 }, () => ({ mes: 'may' })) },
    {
      ...BARS,
      series: Array.from({ length: MAX_SERIES + 1 }, (_, i) => ({ key: `s${String(i)}` })),
    },
  ])('refuses what cannot be drawn: %#', (raw) => {
    expect(normalizeChart(raw)).toBeNull();
  });

  it('reads a ```mango-chart``` block as JSON only', () => {
    expect(parseChartBlock(JSON.stringify(BARS))?.chartType).toBe('bar');
    expect(parseChartBlock('{"chartType": "bar", "data": [')).toBeNull();
    expect(parseChartBlock('alert(1)')).toBeNull();
  });
});

describe('«Copiar datos» (D118 (4))', () => {
  it('puts a quote before a text a spreadsheet would run, and keeps numbers as numbers', () => {
    for (const formula of ['=HYPERLINK("x")', '+1', '-cmd', '@SUM(A1)', '\tx']) {
      expect(tsvCell(formula).startsWith("'")).toBe(true);
    }
    expect(tsvCell(-5)).toBe('-5');
    expect(tsvCell('EC2')).toBe('EC2');
    expect(tsvCell('a\tb\nc')).toBe('a b c');
    expect(tsvCell(null)).toBe('');
  });

  it('copies the x column and a column per series, in the locale, without grouping', () => {
    const spec = normalizeChart({ ...BARS, data: [{ mes: '=may', EC2: 41200.5, S3: 12800 }] });
    expect(spec).not.toBeNull();
    const decimal = new Intl.NumberFormat().format(0.5).charAt(1);
    expect(chartTsv(must(spec))).toBe(`mes\tEC2\tS3\n'=may\t41200${decimal}5\t12800`);
  });

  it('copies only the first series of a pie, the one it draws', () => {
    const spec = normalizeChart({ ...BARS, chartType: 'pie' });
    expect(chartTsv(must(spec)).split('\n')[0]).toBe('mes\tEC2');
  });
});

describe('numbers with Intl and the browser`s locale (design round 40 `crFmt`)', () => {
  it('formats compact, integer and raw values with their affixes', () => {
    const compact = new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(58300);
    expect(formatValue(58300, 'compact')).toBe(compact);
    expect(formatValue(1234.6, 'integer')).toBe(new Intl.NumberFormat().format(1235));
    expect(formatValue(0.25, 'raw', { valuePrefix: 'USD ', valueSuffix: '' })).toBe(
      `USD ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(0.25)}`,
    );
    expect(formatValue('may', 'compact')).toBe('may');
    expect(formatValue(null, 'compact')).toBe('');
  });

  it('shows a table cell as an integer or with up to four decimals', () => {
    expect(formatCell(1248)).toBe(new Intl.NumberFormat().format(1248));
    expect(formatCell(0.123456)).toBe(
      new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(0.1235),
    );
    expect(formatCell(true)).toBe('true');
    expect(formatCell(null)).toBe('');
  });
});
