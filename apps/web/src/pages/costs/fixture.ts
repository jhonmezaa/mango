import type { AgentCost, Costs } from './model';

/** GET /api/costs of the 20th of a 30-day month (tests only). */
export function costsFixture(overrides: Partial<Costs> = {}): Costs {
  const day = (n: number, spent: string) => ({
    day: `2026-11-${String(n).padStart(2, '0')}`,
    spent_usd: spent,
    turns: 2,
  });
  const agent = (over: Partial<AgentCost>): AgentCost => ({
    id: 'finops',
    spent_usd: '6.00',
    turns: 120,
    previous_usd: '4.00',
    projected_usd: '9.00',
    name: 'FinOps',
    category: 'Finanzas',
    model: 'us.anthropic.claude-sonnet-4-6',
    budget: { limit_usd: '8.00', spent_usd: '6.50' },
    ...over,
  });
  return {
    month: '2026-11',
    previous_month: '2026-10',
    days_in_month: 30,
    elapsed_days: 20,
    closed: false,
    counted_since: '2026-05-03',
    days: Array.from({ length: 20 }, (_, i) => day(i + 1, '0.500000')),
    previous_days: Array.from({ length: 31 }, (_, i) => ({
      day: `2026-10-${String(i + 1).padStart(2, '0')}`,
      spent_usd: '0.300000',
      turns: 1,
    })),
    spent_usd: '10.00',
    turns: 200,
    previous_usd: '9.30',
    previous_turns: 31,
    projected_usd: '15.00',
    agents: {
      counted_since: '2026-09-17',
      unattributed_usd: '0.10',
      previous_unattributed_usd: '0.00',
      before_since_usd: '0.00',
      previous_before_since_usd: '0.00',
      rows: [
        agent({}),
        agent({
          id: 'legal',
          spent_usd: '3.90',
          turns: 70,
          previous_usd: '5.00',
          projected_usd: '5.85',
          name: '=HYPERLINK("x")',
          category: null,
          budget: { limit_usd: '8.00', spent_usd: '3.90' },
        }),
      ],
    },
    models: {
      counted_since: '2026-11-12',
      unattributed_usd: '4.10',
      previous_unattributed_usd: '9.30',
      before_since_usd: '4.00',
      previous_before_since_usd: '9.30',
      rows: [
        {
          id: 'us.anthropic.claude-sonnet-4-6',
          spent_usd: '5.90',
          turns: 110,
          previous_usd: '0.00',
          projected_usd: null,
        },
      ],
    },
    sources: {
      counted_since: '2026-11-12',
      unattributed_usd: '4.10',
      previous_unattributed_usd: '9.30',
      before_since_usd: '4.00',
      previous_before_since_usd: '9.30',
      rows: ['chat', 'task', 'playground', 'eval'].map((id, i) => ({
        id,
        spent_usd: ['4.00', '1.90', '0.00', '0.00'][i] ?? '0.00',
        turns: 10,
        previous_usd: '0.00',
        projected_usd: null,
      })),
    },
    ...overrides,
  };
}
