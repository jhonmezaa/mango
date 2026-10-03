import { describe, expect, it } from 'vitest';

import {
  NO_FILTERS,
  formatPrice,
  hasFilters,
  isKnownModel,
  matchingModels,
  parsePrice,
  priceInputValue,
  formatContext,
  providersOf,
  sortModels,
  typicalQueryCost,
  type Model,
} from './model';

function model(overrides: Partial<Model> & Pick<Model, 'id'>): Model {
  return {
    name: overrides.id,
    provider: 'Anthropic',
    status: 'available',
    is_default: false,
    supports_tools: true,
    supports_vision: false,
    context_tokens: null,
    input_usd: '3',
    output_usd: '15',
    cache_read_usd: null,
    cache_write_usd: null,
    list_input_usd: null,
    list_output_usd: null,
    confirmed_by: null,
    confirmed_at: null,
    disabled_by: null,
    disabled_at: null,
    disabled_reason: null,
    agents: [],
    ...overrides,
  };
}

const MODELS = [
  model({ id: 'us.meta.llama', name: 'Llama', provider: 'Meta', status: 'noaccess' }),
  model({ id: 'us.anthropic.opus', name: 'Opus', status: 'disabled', supports_vision: true }),
  model({ id: 'us.amazon.nova', name: 'Nova', provider: 'Amazon', supports_tools: false }),
  model({ id: 'us.anthropic.sonnet', name: 'Sonnet', status: 'enabled', supports_vision: true }),
  model({ id: 'us.anthropic.haiku', name: 'Haiku' }),
];

describe('model filters', () => {
  it('orders by status, then provider, then name', () => {
    expect(sortModels(MODELS).map((item) => item.name)).toEqual([
      'Sonnet',
      'Nova',
      'Haiku',
      'Opus',
      'Llama',
    ]);
  });

  it('searches the name, the provider and the id', () => {
    const search = (query: string) =>
      matchingModels(MODELS, { ...NO_FILTERS, query }).map((item) => item.name);
    expect(search('  SONN ')).toEqual(['Sonnet']);
    expect(search('meta')).toEqual(['Llama']);
    expect(search('us.amazon')).toEqual(['Nova']);
    expect(search('nothing')).toEqual([]);
  });

  it('filters by provider and capabilities, not by status', () => {
    const names = (filters: Partial<typeof NO_FILTERS>) =>
      matchingModels(MODELS, { ...NO_FILTERS, ...filters }).map((item) => item.name);
    expect(names({ provider: 'Anthropic' })).toEqual(['Opus', 'Sonnet', 'Haiku']);
    expect(names({ tools: true })).not.toContain('Nova');
    expect(names({ vision: true })).toEqual(['Opus', 'Sonnet']);
    // The status counters are computed over this list.
    expect(names({ status: 'enabled' })).toHaveLength(MODELS.length);
  });

  it('knows when a filter is on and lists the providers once', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, query: '  ' })).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, vision: true })).toBe(true);
    expect(providersOf(MODELS)).toEqual(['Amazon', 'Anthropic', 'Meta']);
  });
});

describe('prices', () => {
  it('formats like the design, without rounding a confirmed price', () => {
    expect(formatPrice('3')).toBe('USD 3,00');
    expect(formatPrice('0.8')).toBe('USD 0,80');
    expect(formatPrice('0.0375')).toBe('USD 0,0375');
    expect(formatPrice('1250.5')).toBe('USD 1250,50');
    expect(formatPrice('n/a')).toBe('n/a');
  });

  it('shows the stored price in the notation the form reads back', () => {
    expect(priceInputValue('0.8')).toBe('0,8');
    expect(priceInputValue('15')).toBe('15');
    expect(priceInputValue('1250.5')).toBe('1250,5');
    expect(priceInputValue(null)).toBe('');
    for (const amount of ['0.8', '15', '250.5', '0.0375']) {
      expect(parsePrice(priceInputValue(amount))).toMatchObject({ ok: true, value: amount });
    }
  });

  it.each([
    ['3', '3'],
    ['0,8', '0.8'],
    ['1.000', '1000'],
    [' 1.000,0 ', '1000.0'],
    ['1.250', '1250'],
    ['100.000', '100000'],
    ['99999,9999', '99999.9999'],
    ['12,', '12'],
    ['0,0375', '0.0375'],
  ])('reads %s as %s', (text, value) => {
    expect(parsePrice(text)).toEqual({ ok: true, value, amount: Number(value) });
  });

  it.each([
    ['', 'positive'],
    ['0', 'positive'],
    ['0,00', 'positive'],
    ['-3', 'positive'],
    ['abc', 'positive'],
    ['1,2,3', 'positive'],
    // A dot is only a thousands separator: "0.8" is never read as 8.
    ['0.8', 'comma'],
    ['3.5', 'comma'],
    ['1.25,5', 'comma'],
    // Up to USD 100.000 per million (the API's limit), with at most four decimals.
    ['0,00001', 'range'],
    ['100.000,01', 'range'],
    ['100001', 'range'],
    ['1.000.000', 'range'],
    ['1e3', 'range'],
  ])('rejects %j (%s)', (text, reason) => {
    expect(parsePrice(text)).toEqual({ ok: false, reason });
  });

  it('takes a model without tools and without context for one the release does not know', () => {
    expect(isKnownModel({ supports_tools: false, context_tokens: null })).toBe(false);
    expect(isKnownModel({ supports_tools: false, context_tokens: 128_000 })).toBe(true);
    expect(isKnownModel({ supports_tools: true, context_tokens: null })).toBe(true);
  });

  it('formats the context size like the design', () => {
    expect(formatContext(200_000)).toBe('200k');
    expect(formatContext(128_000)).toBe('128k');
    expect(formatContext(1_000_000)).toBe('1M');
    expect(formatContext(1_500_000)).toBe('1,5M');
  });

  it('estimates a typical query', () => {
    expect(typicalQueryCost(3, 15)).toBe('0,021');
    expect(typicalQueryCost(0.8, 4)).toBe('0,0056');
  });
});
