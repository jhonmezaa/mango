import { zChartSpecOutSchema, type zChartSeriesOutSchema } from '@mango/api-client/schemas';
import type { z } from 'zod';

/**
 * Charts of the chat (D118, G1). A chart comes from the API already normalized
 * (`GET …/files/{file}/output`, `mango_api.chat_outputs`) or from a ```` ```mango-chart ````
 * block of the answer's text, which is parsed here with the same rules and then validated with
 * the schema generated from the server's (`zChartSpecOutSchema`): the same closed spec either
 * way. Everything in a spec is untrusted data from the model: it is drawn as text and numbers,
 * never as HTML nor code.
 */
export type ChartSpec = z.output<typeof zChartSpecOutSchema>;
type ChartSpecOut = ChartSpec;
type ChartSeriesOut = z.output<typeof zChartSeriesOutSchema>;
export type ChartValue = ChartSpec['data'][number][string];

export const MAX_ROWS = 5_000;
export const MAX_SERIES = 20;
const MAX_COLUMNS = 64;
const KEY_CHARS = 64;
const LABEL_CHARS = 120;
const TITLE_CHARS = 200;
const VALUE_CHARS = 200;
const AFFIX_CHARS = 16;
/** A block over this is not parsed (the server's cap on a spec file). */
const MAX_BLOCK_CHARS = 2 * 1024 * 1024;

type ValueFormat = ChartSpecOut['valueFormat'];
const CHART_TYPES = new Set(['bar', 'line', 'pie', 'scatter']);
const FORMATS = new Set(['compact', 'integer', 'raw', 'currency']);
/** An ISO 4217 code (design round 41): `Intl` formats the amounts with it. */
const CURRENCY = /^[A-Z]{3}$/;
/** The currency of a `currency` chart that does not name a valid one (`DEFAULT_CURRENCY`). */
export const DEFAULT_CURRENCY = 'USD';

/** Keys a row or a series may not use: rows are plain JavaScript objects (prototype pollution). */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, cap: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, cap) : null;
}

function columnKey(value: unknown): string | null {
  const key = text(value, KEY_CHARS);
  return key && !RESERVED_KEYS.has(key) ? key : null;
}

function plain(value: unknown): ChartValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, VALUE_CHARS);
  return null;
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function rows(raw: unknown): ChartSpecOut['data'] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) return null;
  const out: ChartSpecOut['data'] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const row: Record<string, ChartValue> = {};
    let count = 0;
    for (const [key, value] of Object.entries(item)) {
      if (!key || key.length > KEY_CHARS || RESERVED_KEYS.has(key)) continue;
      if (count >= MAX_COLUMNS) break;
      row[key] = plain(value);
      count += 1;
    }
    if (count > 0) out.push(row);
  }
  return out;
}

function format(value: unknown, fallback: ValueFormat): ValueFormat {
  return typeof value === 'string' && FORMATS.has(value) ? (value as ValueFormat) : fallback;
}

function currencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return CURRENCY.test(code) ? code : null;
}

function axisLabel(raw: unknown, dimension: 'x' | 'y', fallback: unknown): string | null {
  if (isObject(raw)) {
    const axis = raw[dimension];
    const label = isObject(axis) ? text(axis.label, LABEL_CHARS) : null;
    if (label) return label;
  } else if (Array.isArray(raw)) {
    for (const axis of raw) {
      if (isObject(axis) && axis.dimension === dimension) {
        const label = text(axis.label, LABEL_CHARS);
        if (label) return label;
      }
    }
  }
  return text(fallback, LABEL_CHARS);
}

/**
 * A chart spec as the chat draws it, or null when it cannot be drawn (the server's
 * `parse_chart`): an unknown field is ignored and an invalid one falls back to its default;
 * only a missing `chartType`, no rows or a spec over 5,000 rows or 20 series is refused.
 */
export function normalizeChart(raw: unknown): ChartSpec | null {
  if (!isObject(raw)) return null;
  const chartType = raw.chartType;
  if (typeof chartType !== 'string' || !CHART_TYPES.has(chartType)) return null;
  const data = rows(raw.data);
  if (!data || data.length === 0) return null;
  const first = data[0] ?? {};
  const xKey =
    columnKey(raw.xKey) ??
    Object.entries(first).find(([, v]) => typeof v === 'string')?.[0] ??
    Object.keys(first)[0] ??
    'name';
  const valueKey =
    columnKey(raw.valueKey) ??
    Object.entries(first).find(([k, v]) => k !== xKey && isNumber(v))?.[0] ??
    'value';
  const valueFormat = format(raw.valueFormat, 'compact');
  const prefix = text(raw.valuePrefix, AFFIX_CHARS) ?? '';
  const suffix = text(raw.valueSuffix, AFFIX_CHARS) ?? '';
  const seriesRaw = Array.isArray(raw.series) ? raw.series : [];
  if (seriesRaw.length > MAX_SERIES) return null;
  const series: ChartSeriesOut[] = [];
  for (const item of seriesRaw) {
    if (!isObject(item)) continue;
    const key = columnKey(item.key) ?? columnKey(item.dataKey);
    if (!key) continue;
    series.push({
      key,
      label: text(item.label, LABEL_CHARS) ?? key,
      valueFormat: format(item.valueFormat, valueFormat),
      valuePrefix: text(item.valuePrefix, AFFIX_CHARS) ?? prefix,
      valueSuffix: text(item.valueSuffix, AFFIX_CHARS) ?? suffix,
      stack: text(item.stack, KEY_CHARS),
    });
  }
  if (series.length === 0) {
    series.push({
      key: valueKey,
      label: valueKey,
      valueFormat,
      valuePrefix: prefix,
      valueSuffix: suffix,
      stack: null,
    });
  }
  const money = valueFormat === 'currency' || series.some((s) => s.valueFormat === 'currency');
  const meta = isObject(raw.meta) ? raw.meta : {};
  const spec = {
    chartType,
    data,
    xKey,
    series,
    layout: chartType === 'bar' && raw.layout === 'vertical' ? 'vertical' : 'horizontal',
    valueFormat,
    currency: money ? (currencyCode(raw.currency) ?? DEFAULT_CURRENCY) : null,
    axes: {
      x: { label: axisLabel(raw.axes, 'x', raw.xAxisLabel) },
      y: { label: axisLabel(raw.axes, 'y', raw.yAxisLabel) },
    },
    meta: {
      title: text(meta.title, TITLE_CHARS),
      subtitle: text(meta.subtitle, TITLE_CHARS) ?? text(meta.description, TITLE_CHARS),
      footer: text(meta.footer, TITLE_CHARS),
    },
  };
  // The schema of the server, generated (packages/ts/api-client): the closed spec.
  const checked = zChartSpecOutSchema.safeParse(spec);
  return checked.success ? checked.data : null;
}

/** The body of a ```` ```mango-chart ```` block: JSON, normalized; null when it cannot be. */
export function parseChartBlock(body: string): ChartSpec | null {
  if (body.length > MAX_BLOCK_CHARS) return null;
  try {
    return normalizeChart(JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

/** The fence language of a chart in the answer's text (D118 (2)). */
export const CHART_FENCE = 'mango-chart';

// --- Numbers: `Intl` with the browser's locale (design round 40 `crFmt`) ---------------------

const formatters = new Map<string, Intl.NumberFormat>();
function formatter(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.NumberFormat(undefined, options);
    formatters.set(key, found);
  }
  return found;
}

/**
 * Money in the browser's locale (design round 41 `crFmt`): no decimals from 100, two below it.
 * A code `Intl` does not accept falls back to dollars.
 */
function money(value: number, currency: string, digits: number, compact = false): string {
  const key = `currency-${currency}-${String(digits)}-${String(compact)}`;
  const options: Intl.NumberFormatOptions = {
    style: 'currency',
    currency,
    minimumFractionDigits: compact ? 0 : digits,
    maximumFractionDigits: digits,
    ...(compact ? { notation: 'compact' } : {}),
  };
  try {
    return formatter(key, options).format(value);
  } catch {
    return currency === DEFAULT_CURRENCY ? String(value) : money(value, DEFAULT_CURRENCY, digits);
  }
}

/**
 * A value as the chart shows it: compact («58 mil»), integer, raw or money («$58,300»), with
 * its affixes.
 */
export function formatValue(
  value: ChartValue | undefined,
  valueFormat: ValueFormat,
  series?: Pick<ChartSeriesOut, 'valuePrefix' | 'valueSuffix'>,
  currency?: string | null,
): string {
  if (typeof value !== 'number') return value === null || value === undefined ? '' : String(value);
  const number =
    valueFormat === 'currency'
      ? money(value, currency ?? DEFAULT_CURRENCY, Math.abs(value) >= 100 ? 0 : 2)
      : valueFormat === 'compact'
        ? formatter('compact', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
        : valueFormat === 'integer'
          ? formatter('integer', { maximumFractionDigits: 0 }).format(value)
          : formatter('raw', { maximumFractionDigits: 6 }).format(value);
  return `${series?.valuePrefix ?? ''}${number}${series?.valueSuffix ?? ''}`;
}

/**
 * A tick of the value axis (design round 41): money without decimals («$6,000»), compact from
 * 100,000 («$1.2M»); any other format, compact.
 */
export function formatTick(value: number, valueFormat: ValueFormat, currency?: string | null) {
  if (valueFormat === 'currency') {
    const big = Math.abs(value) >= 100_000;
    return money(value, currency ?? DEFAULT_CURRENCY, big ? 1 : 0, big);
  }
  return formatter('compact', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Design round 41 `crNice`: a «round» scale from 0 to a top in 4 or 5 steps (0, 1.500, 3.000…). */
export function niceScale(max: number): { top: number; step: number } {
  if (!(max > 0) || !Number.isFinite(max)) return { top: 1, step: 0.25 };
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const m = raw / power;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * power;
  return { top: Math.ceil(max / step) * step, step };
}

/** The ticks of a scale, from 0 to its top. */
export function scaleTicks({ top, step }: { top: number; step: number }): number[] {
  const ticks: number[] = [];
  for (let i = 0; i * step <= top + step / 2; i += 1) ticks.push(i * step);
  return ticks;
}

/** Design round 41 `crCut`: a label cut to `max` characters with «…». */
export function cutLabel(value: ChartValue | undefined, max: number): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/** A number of a table cell: whole numbers as integers, others with up to four decimals. */
export function formatCell(value: ChartValue | undefined): string {
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? formatter('cell', { maximumFractionDigits: 0 }).format(value)
      : formatter('cell-decimal', { maximumFractionDigits: 4 }).format(value);
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

// --- «Copiar datos» (D118 (4)) ---------------------------------------------------------------

const FORMULA = /^[=+\-@\t\r]/;

/**
 * A cell of the copied table: a text a spreadsheet would read as a formula gets a `'` in front
 * (CSV injection), and tabs or line breaks inside it become spaces so that the table keeps its
 * shape. Numbers go in the person's locale, without grouping, so a spreadsheet reads them.
 */
export function tsvCell(value: ChartValue | undefined): string {
  if (typeof value === 'number') {
    return formatter('tsv', { useGrouping: false, maximumFractionDigits: 6 }).format(value);
  }
  if (value === null || value === undefined) return '';
  const cell = String(value);
  const flat = cell.replace(/[\t\r\n]+/g, ' ');
  return FORMULA.test(cell) ? `'${flat}` : flat;
}

/** The name of the chart's x column (design round 41 `xLabel`): its axis label, or its key. */
export const xLabelOf = (spec: ChartSpec): string => spec.axes.x.label ?? spec.xKey;

/**
 * The chart's data as a table separated by tabs: its x column, then a column per series, every
 * row and every series (the hidden ones too, design round 41).
 */
export function chartTsv(spec: ChartSpec): string {
  const shown = spec.chartType === 'pie' ? spec.series.slice(0, 1) : spec.series;
  const head = [xLabelOf(spec), ...shown.map((s) => s.label)].map(tsvCell).join('\t');
  const body = spec.data.map((row) =>
    [row[spec.xKey], ...shown.map((s) => row[s.key])].map(tsvCell).join('\t'),
  );
  return [head, ...body].join('\n');
}
