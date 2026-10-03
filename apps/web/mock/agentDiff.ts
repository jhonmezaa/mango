/**
 * Diff of a version against the published one, as apps/api `diff_definitions` computes it. Shared
 * by the mocks that answer `VersionOut` (`agentBuilder.ts`, `agentReview.ts`); it holds no state.
 */
import type { MockAgentDefinition } from './agents.ts';

const SCALAR_FIELDS = [
  'name',
  'description',
  'category',
  'icon',
  'color',
  'reports_to',
  'role',
  'model',
] as const;
const LIMIT_FIELDS = [
  'max_tokens',
  'max_iterations',
  'timeout_seconds',
  'max_tokens_per_call',
  'temperature',
] as const;
const SET_FIELDS = ['allowed_models', 'tools', 'approval_tools', 'groups', 'users'] as const;

interface PromptLine {
  op: '+' | '-' | ' ';
  text: string;
}

/** Line diff by longest common subsequence; prompts of the mock are a few lines long. */
function promptDiff(before: string, after: string): PromptLine[] | null {
  if (before === after) return null;
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = lcs[i] ?? [];
      row[j] =
        a[i] === b[j]
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const lines: PromptLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ op: ' ', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if (
      i < a.length &&
      (j >= b.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))
    ) {
      lines.push({ op: '-', text: a[i] ?? '' });
      i += 1;
    } else {
      lines.push({ op: '+', text: b[j] ?? '' });
      j += 1;
    }
  }
  return lines;
}

export function diffDefinitions(base: MockAgentDefinition | null, definition: MockAgentDefinition) {
  const fields: { field: string; before: string | number | null; after: string | number | null }[] =
    [];
  if (base) {
    for (const field of SCALAR_FIELDS) {
      if (base[field] !== definition[field]) {
        fields.push({ field, before: base[field], after: definition[field] });
      }
    }
    for (const field of LIMIT_FIELDS) {
      if (base.limits[field] !== definition.limits[field]) {
        fields.push({
          field: `limits.${field}`,
          before: base.limits[field],
          after: definition.limits[field],
        });
      }
    }
  }
  const sets: { field: string; added: string[]; removed: string[] }[] = [];
  for (const field of SET_FIELDS) {
    const before = base ? base[field] : [];
    const added = definition[field].filter((value) => !before.includes(value)).sort();
    const removed = before.filter((value) => !definition[field].includes(value)).sort();
    if (added.length > 0 || removed.length > 0) sets.push({ field, added, removed });
  }
  const prompt = promptDiff(base ? base.system_prompt : '', definition.system_prompt);
  const changes =
    fields.length +
    sets.reduce((total, change) => total + change.added.length + change.removed.length, 0) +
    (prompt ? 1 : 0);
  return { is_new: base === null, fields, sets, prompt, changes };
}
