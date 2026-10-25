import type { OperationOutput } from '../../api/operations';
import { pctLabel, pctOf, shortId, toNumber } from '../../components/admin/govFormat';

// What the Gobernanza view derives from GET /api/governance (design other-views.jsx `Governance`,
// round 19 «Disponible hoy», D89). The server decides what each person may read: a section it
// leaves `null` is not shown, and nothing here decides authorization.

export type Governance = OperationOutput<'getGovernance'>;
export type ApprovalsSummary = NonNullable<Governance['approvals']>;
export type BudgetLine = NonNullable<Governance['budgets']>['over_warn'][number];
export type PolicyLine = ApprovalsSummary['policies'][number];

export type Tone = 'amber' | 'red' | 'blue';

export interface Visible {
  budgets: boolean;
  areas: boolean;
  audit: boolean;
}

/** What the sections say the person may see; before loading, what the account suggests. */
export function visibleOf(data: Governance): Visible {
  return { budgets: data.budgets !== null, areas: data.areas !== null, audit: data.audit !== null };
}

export const NO_APPROVALS: ApprovalsSummary = {
  pending: 0,
  mine: 0,
  mine_soon: 0,
  next_expires_at: null,
  approved_7d: 0,
  rejected_7d: 0,
  policies: [],
  capped: false,
};

/** Minutes until `iso`, rounded down and never negative; null when it cannot be read. */
export function minutesUntil(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((at - now) / 60_000));
}

export function budgetPercent(line: BudgetLine): number {
  return pctOf(toNumber(line.spent_usd), toNumber(line.limit_usd));
}

/** The budget's name as the budgets screen: the agent's name or the person's email. */
export function budgetName(line: BudgetLine, releaseAgentName: string): string {
  if (line.name) return line.name;
  if (line.scope === 'agent') return line.id === 'finops' ? releaseAgentName : line.id;
  return shortId(line.id);
}

/** Design: the first two budgets over the threshold, «FinOps 85 % · persona 100 %». */
export function budgetSub(lines: readonly BudgetLine[], releaseAgentName: string): string {
  return lines
    .slice(0, 2)
    .map((line) => `${budgetName(line, releaseAgentName)} ${pctLabel(budgetPercent(line))}`)
    .join(' · ');
}

/** Which sections the person does not see, in the order of the design's subtitle. */
export function hiddenOf(visible: Visible): ('budgets' | 'areas' | 'audit')[] {
  return (['budgets', 'areas', 'audit'] as const).filter((key) => !visible[key]);
}
