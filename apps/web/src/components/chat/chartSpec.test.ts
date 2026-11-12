import { describe, expect, it } from 'vitest';

import {
  chartTsv,
  cutLabel,
  formatCell,
  formatTick,
  formatValue,
  MAX_ROWS,
  MAX_SERIES,
  niceScale,
  normalizeChart,
  parseChartBlock,
  scaleTicks,
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
      valueFormat: 'percent',
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

  it('names money with an ISO code, dollars when it names none valid (design round 41)', () => {
    const money = normalizeChart({ ...BARS, valueFormat: 'currency', currency: ' eur ' });
    expect([money?.valueFormat, money?.currency]).toEqual(['currency', 'EUR']);
    expect(money?.series.every((s) => s.valueFormat === 'currency')).toBe(true);
    for (const code of [undefined, 'EURO', '€', 840]) {
      expect(normalizeChart({ ...BARS, valueFormat: 'currency', currency: code })?.currency).toBe(
        'USD',
      );
    }
    expect(normalizeChart({ ...BARS, currency: 'EUR' })?.currency).toBeNull();
  });

  it('copies the axis label of x as its header when it has one', () => {
    const spec = normalizeChart({ ...BARS, axes: { x: { label: 'Mes' } } });
    expect(chartTsv(must(spec)).split('\n')[0]).toBe('Mes\tEC2\tS3');
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

  it('formats money with Intl: no decimals from 100, two below it (design round 41)', () => {
    const usd = (digits: number) =>
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    expect(formatValue(58300, 'currency', undefined, 'USD')).toBe(usd(0).format(58300));
    expect(formatValue(99.5, 'currency', undefined, 'USD')).toBe(usd(2).format(99.5));
    expect(formatValue(1234, 'currency')).toBe(usd(0).format(1234));
    const eur = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    });
    expect(formatValue(1500, 'currency', undefined, 'EUR')).toBe(eur.format(1500));
  });

  it('labels the money axis without decimals, compact from 100,000', () => {
    expect(formatTick(6000, 'currency', 'USD')).toBe(
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(6000),
    );
    expect(formatTick(1_200_000, 'currency', 'USD')).toBe(
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        notation: 'compact',
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      }).format(1_200_000),
    );
  });

  it('builds a round scale in four or five steps (`crNice`)', () => {
    expect(niceScale(58300)).toEqual({ top: 60000, step: 20000 });
    expect(niceScale(900)).toEqual({ top: 1000, step: 250 });
    expect(niceScale(0)).toEqual({ top: 1, step: 0.25 });
    expect(scaleTicks(niceScale(5820))).toEqual([0, 2000, 4000, 6000]);
  });

  it('cuts a long label with «…» (`crCut`)', () => {
    expect(cutLabel('Amazon Relational Database Service', 30)).toBe(
      'Amazon Relational Database Se…',
    );
    expect(cutLabel('EC2', 30)).toBe('EC2');
    expect(cutLabel(null, 30)).toBe('');
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
