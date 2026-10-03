import type { z } from 'zod';

import type { zAdminModelOutSchema, zAdminModelsOutSchema } from '@mango/api-client/schemas';

// Pure helpers of the Brains screen (design models-view.jsx): filters, order and prices.

export type Model = z.output<typeof zAdminModelOutSchema>;
export type Catalog = z.output<typeof zAdminModelsOutSchema>;
export type ModelStatus = Model['status'];
export type StatusFilter = 'all' | ModelStatus;

/** Design order of the list: what can be used first. */
export const STATUS_ORDER: readonly ModelStatus[] = [
  'enabled',
  'available',
  'disabled',
  'noaccess',
];

/** Design `MV_STATUS`: badge tone of each status. */
export const STATUS_TONE: Record<ModelStatus, 'green' | 'neutral' | 'red'> = {
  enabled: 'green',
  available: 'neutral',
  disabled: 'neutral',
  noaccess: 'red',
};

export interface Filters {
  query: string;
  status: StatusFilter;
  provider: string;
  tools: boolean;
  vision: boolean;
}

export const NO_FILTERS: Filters = {
  query: '',
  status: 'all',
  provider: 'all',
  tools: false,
  vision: false,
};

export function hasFilters(filters: Filters): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.status !== 'all' ||
    filters.provider !== 'all' ||
    filters.tools ||
    filters.vision
  );
}

/** Everything but the status filter: the status counters are computed over this list. */
export function matchingModels(models: readonly Model[], filters: Filters): Model[] {
  const needle = filters.query.trim().toLowerCase();
  return models.filter(
    (model) =>
      (filters.provider === 'all' || model.provider === filters.provider) &&
      (!filters.tools || model.supports_tools) &&
      (!filters.vision || model.supports_vision) &&
      (!needle || `${model.name} ${model.provider} ${model.id}`.toLowerCase().includes(needle)),
  );
}

export function sortModels(models: readonly Model[]): Model[] {
  return models.toSorted(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      a.provider.localeCompare(b.provider) ||
      a.name.localeCompare(b.name),
  );
}

export function providersOf(models: readonly Model[]): string[] {
  return [...new Set(models.map((model) => model.provider))].toSorted((a, b) => a.localeCompare(b));
}

const LOCALE = 'es-ES';
// Design `mvPrice`: at least two decimals. Prices under 1 keep up to four (the API's precision)
// so that a confirmed price is never shown rounded.
const priceSmall = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const priceLarge = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const typical = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 4 });
const input = new Intl.NumberFormat(LOCALE, { useGrouping: false, maximumFractionDigits: 4 });

/** "USD 3,00" from the API's decimal string. Unparseable input is returned unchanged. */
/** Design `mvCtx`: context size in thousands or millions of tokens. */
export function formatContext(tokens: number): string {
  return tokens >= 1e6
    ? `${(tokens / 1e6).toLocaleString('es-ES')}M`
    : `${String(Math.round(tokens / 1000))}k`;
}

export function formatPrice(amount: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  return `USD ${(value < 1 ? priceSmall : priceLarge).format(value)}`;
}

/** The API's decimal string as the user types it: comma for decimals, no grouping. */
export function priceInputValue(amount: string | null): string {
  if (amount === null) return '';
  const value = Number(amount);
  return Number.isFinite(value) ? input.format(value) : '';
}

/** A price per million tokens goes up to USD 100.000: the API's limit (`MAX_PRICE_USD`). */
export const MAX_PRICE = 100_000;
const PRICE_PATTERN = /^\d{1,6}(\.\d{1,4})?$/;
const GROUPED_PATTERN = /^\d{1,3}(\.\d{3})+(,\d*)?$/;

export type ParsedPrice =
  | { ok: true; value: string; amount: number }
  | { ok: false; reason: 'comma' | 'positive' | 'range' };

/**
 * A price as typed in Spanish notation ("1.250,5") into the decimal string the API takes
 * ("1250.5"). Design rules, in its order: the dot only groups thousands, greater than 0, at
 * most 100.000 with four decimals. The server validates again; this only helps the form.
 */
export function parsePrice(text: string): ParsedPrice {
  const typed = text.trim();
  // "0.8" is not read as 8: the decimal sign is the comma.
  if (typed.includes('.') && !GROUPED_PATTERN.test(typed)) return { ok: false, reason: 'comma' };
  const normalized = typed.replace(/\./g, '').replace(',', '.').replace(/\.$/, '');
  const amount = Number(normalized);
  if (normalized === '' || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'positive' };
  }
  if (!PRICE_PATTERN.test(normalized) || amount > MAX_PRICE) return { ok: false, reason: 'range' };
  return { ok: true, value: normalized, amount };
}

/**
 * Design `mvKnown`: the release knows nothing about a model it does not list, so it joins the
 * catalog without tool use and without a context size. The API has no flag for it; this is
 * what such a model looks like.
 */
export function isKnownModel(model: Pick<Model, 'supports_tools' | 'context_tokens'>): boolean {
  return model.supports_tools || model.context_tokens !== null;
}

/** Design: cost of 3 000 input tokens and 800 output tokens, in USD. */
export function typicalQueryCost(inputUsd: number, outputUsd: number): string {
  return typical.format((inputUsd * 3000 + outputUsd * 800) / 1e6);
}
