import type { TFunction } from 'i18next';

import { ApiError } from '../../api/errors';
import type { OperationOutput } from '../../api/operations';
import type { Issue } from './model';

export type Agent = OperationOutput<'getAgents'>['items'][number];

/** Design evPct: a score of the API (0 to 100) as a percentage. */
export function pct(score: number): string {
  return `${String(Math.round(score))}%`;
}

const ERROR_CODES = new Set([
  'evals_unavailable',
  'run_in_progress',
  'version_conflict',
  'judge_unavailable',
  'model_unavailable',
  'secret_in_case',
  'secret_in_suite',
  'too_many_suites',
  'agent_retired',
  'forbidden',
]);

/** The text of a failed call: the code of the API, never its raw message. */
export function errorText(t: TFunction, cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 429) return t('evals.error.rate_limited');
    if (ERROR_CODES.has(cause.code)) {
      return t(`evals.error.${cause.code as 'evals_unavailable'}`);
    }
    if (cause.status === 403) return t('evals.error.forbidden');
  }
  return t('evals.error.generic');
}

export function issueLabel(t: TFunction, issue: Issue): string {
  return t(`evals.issue.${issue}`);
}

/** Design evCases `why`: the reason code of a failed case, as text. */
export function reasonText(t: TFunction, reason: string | null, value: string): string {
  switch (reason) {
    case 'missing_text':
    case 'tool_not_used':
    case 'disclosed':
    case 'judge_low':
    case 'no_answer':
    case 'judge_failed':
    case 'no_trace':
    case 'budget':
      return t(`evals.reason.${reason}`, { value });
    default:
      return t('evals.reason.other');
  }
}
