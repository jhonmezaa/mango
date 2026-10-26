import type {
  zSkillChangeOutSchema,
  zSkillDetailOutSchema,
  zSkillOutSchema,
  zSkillServerOutSchema,
  zSkillsOutSchema,
} from '@mango/api-client/schemas';
import type { z } from 'zod';

import { apiErrorCode } from '../../api/adminErrors';
import { findSecrets } from '../agentBuilder/model';
import type { Server } from '../mcpCatalog/model';

// Construir › Skills (design skills.jsx, D92): types of the API and the rules of the screen that
// do not need React. The server checks every rule again; these only spare a round trip.

export type SkillsList = z.output<typeof zSkillsOutSchema>;
export type Skill = z.output<typeof zSkillOutSchema>;
export type SkillServer = z.output<typeof zSkillServerOutSchema>;
export type SkillChange = z.output<typeof zSkillChangeOutSchema>;
export type SkillDetail = z.output<typeof zSkillDetailOutSchema>;
export type DataTier = Skill['data_tier'];

/** Limits of `mango_core.skills` (the editor's `maxLength` and its errors). */
export const NAME_MAX_LENGTH = 48;
export const DESCRIPTION_MAX_LENGTH = 140;
export const INSTRUCTIONS_MAX_LENGTH = 20_000;
/** From here the editor shows «{n} / 20.000» (design). */
export const INSTRUCTIONS_COUNTER_FROM = 18_000;
export const OUTPUT_MAX_LENGTH = 40;
export const MAX_OUTPUTS = 10;
export const MAX_SERVERS = 10;
export const REASON_MAX_LENGTH = 500;
export const QUERY_MAX_LENGTH = 80;
/** Hours a request waits for a decision (`CHANGE_LIFETIME`). */
export const CHANGE_TTL_HOURS = 72;

/** `SKILL_ID_PATTERN`: `/skills/<id>` opens its panel only for an id of this shape. */
export const SKILL_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// --- Catalog ----------------------------------------------------------------------------

/** Design `L.DATA_LEVEL`, the options of «Nivel de datos» (`internal` never comes from skills). */
export const LEVEL_FILTERS = ['public', 'internal', 'account_data', 'write'] as const;
export type LevelFilter = 'all' | (typeof LEVEL_FILTERS)[number];
export const AVAILABILITY_FILTERS = ['all', 'ok', 'off'] as const;
export type AvailabilityFilter = (typeof AVAILABILITY_FILTERS)[number];

export interface Filters {
  query: string;
  category: string;
  availability: AvailabilityFilter;
  level: LevelFilter;
}

export const NO_FILTERS: Filters = {
  query: '',
  category: 'all',
  availability: 'all',
  level: 'all',
};

export function hasFilters(filters: Filters): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.category !== 'all' ||
    filters.availability !== 'all' ||
    filters.level !== 'all'
  );
}

export function isLevelFilter(value: string): value is LevelFilter {
  return value === 'all' || (LEVEL_FILTERS as readonly string[]).includes(value);
}

/** Search, category and level: the base the availability counts are made on (design `base`). */
export function searched(skills: readonly Skill[], filters: Filters): Skill[] {
  const query = filters.query.trim().toLowerCase();
  return skills.filter(
    (skill) =>
      (filters.category === 'all' || skill.category === filters.category) &&
      (filters.level === 'all' || skill.data_tier === filters.level) &&
      (!query ||
        [skill.name, skill.description, ...skill.servers.map((server) => server.id)]
          .join(' ')
          .toLowerCase()
          .includes(query)),
  );
}

export function inAvailability(skill: Skill, filter: AvailabilityFilter): boolean {
  return filter === 'all' || (filter === 'ok' ? skill.available : !skill.available);
}

export function filtered(skills: readonly Skill[], filters: Filters): Skill[] {
  return searched(skills, filters).filter((skill) => inAvailability(skill, filters.availability));
}

/** First proposals still waiting (design `pendingNew`): their skill is not in the catalog yet. */
export function pendingNew(list: SkillsList): SkillChange[] {
  const known = new Set(list.items.map((skill) => skill.id));
  return list.changes.filter(
    (change) => change.status === 'pending' && change.version === 1 && !known.has(change.skill_id),
  );
}

/** Requests for new skills, any status (design `ChangeList keys={['create']}`). */
export function creationChanges(list: SkillsList): SkillChange[] {
  return list.changes.filter((change) => change.version === 1);
}

// --- Instructions -----------------------------------------------------------------------

const VARIABLE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** `{{variable}}` of the instructions, once each (design `skVars`). */
export function variablesOf(text: string): string[] {
  return [...new Set([...text.matchAll(VARIABLE)].map((match) => match[1] ?? ''))].filter(Boolean);
}

/** The instructions split into text and `{{variable}}` parts, rendered as text (TM: no HTML). */
export function instructionParts(text: string): { text: string; variable: boolean }[] {
  return text
    .split(/(\{\{\s*[^}]+?\s*\}\})/g)
    .filter((part) => part !== '')
    .map((part) => ({ text: part, variable: part.startsWith('{{') }));
}

/** Id the API gives a new skill from its name (`skill_id_of`, the design's rule). */
export function skillIdOf(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** Name of a copy (design «{name} (copia)»), within the limit of a name. */
export function copyName(name: string, suffix: string): string {
  return name.slice(0, NAME_MAX_LENGTH - suffix.length).trimEnd() + suffix;
}

// --- Line diff ----------------------------------------------------------------------------

export type DiffLine = readonly [' ' | '+' | '-', string];

/** Above this many cells the middle is shown as removed and added, not compared line by line:
 * an approver's browser never builds a table of 20.000 × 20.000 lines. */
const DIFF_MAX_CELLS = 1_000_000;

/**
 * Line diff of two texts (design `lineDiff`, a longest common subsequence). The lines common to
 * the start and the end are left out of the table first.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((line): DiffLine => [' ', line]);
  const tail = a.slice(endA).map((line): DiffLine => [' ', line]);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > DIFF_MAX_CELLS) {
    return [
      ...head,
      ...midA.map((line): DiffLine => ['-', line]),
      ...midB.map((line): DiffLine => ['+', line]),
      ...tail,
    ];
  }
  // dp[i * (m + 1) + j]: longest common subsequence of midA[i:] and midB[j:].
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => dp[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        midA[i] === midB[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      mid.push([' ', midA[i] ?? '']);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) mid.push(['-', midA[i++] ?? '']);
    else mid.push(['+', midB[j++] ?? '']);
  }
  while (i < n) mid.push(['-', midA[i++] ?? '']);
  while (j < m) mid.push(['+', midB[j++] ?? '']);
  return [...head, ...mid, ...tail];
}

// --- Editor -------------------------------------------------------------------------------

export interface Draft {
  name: string;
  category: string;
  description: string;
  instructions: string;
  outputs: string[];
  servers: string[];
}

export type DraftError =
  | 'name'
  | 'instructions'
  | 'secret'
  | 'servers'
  | 'tooManyServers'
  | 'tooManyOutputs'
  | 'instructionsTooLong'
  | 'serversOff'
  | 'exists'
  | 'reason';

/** The editor's errors, in the design's order (`errs` of `SkillEditor`). */
export function draftErrors(
  draft: Draft,
  reason: string,
  {
    isNew,
    takenIds,
    enabledServers,
  }: { isNew: boolean; takenIds: ReadonlySet<string>; enabledServers: ReadonlySet<string> },
): DraftError[] {
  const errors: (DraftError | false)[] = [
    !draft.name.trim() && 'name',
    !draft.instructions.trim() && 'instructions',
    secretIn(draft) && 'secret',
    draft.servers.length === 0 && 'servers',
    draft.servers.length > MAX_SERVERS && 'tooManyServers',
    draft.outputs.length > MAX_OUTPUTS && 'tooManyOutputs',
    draft.instructions.length > INSTRUCTIONS_MAX_LENGTH && 'instructionsTooLong',
    draft.servers.some((id) => !enabledServers.has(id)) && 'serversOff',
    isNew && takenIds.has(skillIdOf(draft.name)) && 'exists',
    !reason.trim() && 'reason',
  ];
  return errors.filter((error): error is DraftError => error !== false);
}

/** The fields the API checks for secrets (D26); only the kind is ever shown. */
export function secretIn(draft: Pick<Draft, 'name' | 'description' | 'instructions' | 'outputs'>) {
  return [draft.name, draft.description, draft.instructions, draft.outputs.join('\n')].some(
    (text) => findSecrets(text).length > 0,
  );
}

/** Servers of the catalog for the editor: enabled first, then by name (design). */
export function editorServers(servers: readonly Server[]): Server[] {
  return servers.toSorted(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
  );
}

/** Errors of the API with a text of their own in the editor; the rest use the shared ones. */
const EDITOR_ERRORS = [
  'too_many_skills',
  'too_many_pending',
  'skill_exists',
  'already_pending',
  'version_conflict',
  'invalid_request',
  'secret_detected',
  'server_not_enabled',
] as const;
export type EditorErrorCode = (typeof EDITOR_ERRORS)[number];

export function editorErrorCode(error: unknown): EditorErrorCode | null {
  const code = apiErrorCode(error);
  return (EDITOR_ERRORS as readonly (string | null)[]).includes(code)
    ? (code as EditorErrorCode)
    : null;
}

/** Errors of a decision with a text of their own (approve, reject, withdraw). */
const DECISION_ERRORS = ['same_approver', 'use_withdraw', 'not_proposer', 'expired'] as const;
export type DecisionErrorCode = (typeof DECISION_ERRORS)[number];

export function decisionErrorCode(error: unknown): DecisionErrorCode | null {
  const code = apiErrorCode(error);
  return (DECISION_ERRORS as readonly (string | null)[]).includes(code)
    ? (code as DecisionErrorCode)
    : null;
}

/** The fields of a version that changed (design `SkChangeBody`), as label and before/after. */
export type ChangedField = 'name' | 'category' | 'description' | 'servers' | 'outputs';

export function changedFields(
  current: Pick<Draft, 'name' | 'category' | 'description' | 'outputs' | 'servers'>,
  change: SkillChange,
): { field: ChangedField; before: string; after: string }[] {
  const pairs: [ChangedField, string, string][] = [
    ['name', current.name, change.name],
    ['category', current.category, change.category],
    ['description', current.description, change.description],
    ['servers', current.servers.join(', '), change.servers.join(', ')],
    ['outputs', current.outputs.join(', '), change.outputs.join(', ')],
  ];
  return pairs
    .filter(([, before, after]) => before !== after)
    .map(([field, before, after]) => ({ field, before, after }));
}

// --- Requests -----------------------------------------------------------------------------

/** The approved version a request starts from, for its fields and its diff. */
export interface Current extends Pick<
  Draft,
  'name' | 'category' | 'description' | 'outputs' | 'servers'
> {
  version: number;
  instructions: string;
  /** Agents that use the skill (the summary of a new version). */
  agents: number;
}

export type Decision =
  { kind: 'approve' } | { kind: 'reject'; note: string } | { kind: 'withdraw' };

/** The approved version a request of this skill is compared with. */
export function currentOf(detail: SkillDetail): Current {
  return {
    name: detail.skill.name,
    category: detail.skill.category,
    description: detail.skill.description,
    outputs: detail.outputs,
    servers: detail.skill.servers.map((server) => server.id),
    version: detail.skill.version,
    instructions: detail.instructions,
    agents: detail.skill.agents,
  };
}
