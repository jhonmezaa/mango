import type { TFunction } from 'i18next';
import type { ComponentType } from 'react';

import { isRuleCode } from '../../agents/rules';
import { ApiError } from '../../api/errors';
import type { OperationOutput } from '../../api/operations';
import type { BadgeTone } from '../../components/Badge';
import {
  ActivityIcon,
  BookOpenIcon,
  BotIcon,
  ChatIcon,
  ClockIcon,
  CloudIcon,
  EyeIcon,
  LockIcon,
  MoneyIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SkillIcon,
  ZapIcon,
  type IconProps,
} from '../../components/icons';

// Data of the review screen, as the generated client returns it. Everything here is API data:
// it is rendered as text and never decides authorization (the API does).

export type Reviews = OperationOutput<'getReviews'>;
export type Review = Reviews['queue'][number];
export type Version = OperationOutput<'readVersion'>;
export type Diff = Version['diff'];
export type Violation = NonNullable<Version['violations']>[number];
type Catalog = OperationOutput<'getCatalog'>;
type Groups = OperationOutput<'listGroups'>;
type Org = OperationOutput<'getOrg'>;

/** Root of the organization chart in `reports_to` (D30). */
export const ROOT_SUPERVISOR = 'platform';

/** Same limit as the API (`Reason`, 1..500). */
export const REASON_MAX_LENGTH = 500;

export function reviewKey(review: Pick<Review, 'agent_id' | 'version'>): string {
  return `${review.agent_id}/${review.version}`;
}

function time(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** An approved version the provisioner is (or may still be) publishing. */
function isPublishing(review: Review): boolean {
  return review.status === 'approved' && !review.retryable;
}

/**
 * Design queue: versions in review plus the approved ones that are still being published, the
 * oldest first. The API lists the approved ones in `history`.
 */
export function pendingReviews(reviews: Reviews): Review[] {
  return [...reviews.queue, ...reviews.history.filter(isPublishing)]
    .filter((review) => review.status === 'in_review' || isPublishing(review))
    .sort((a, b) => time(a.submitted_at) - time(b.submitted_at));
}

/** Design history: what happened to reviewed versions, as the API orders it (newest first). */
export function pastReviews(reviews: Reviews): Review[] {
  return reviews.history.filter((review) => !isPublishing(review));
}

/** Step shown for an approved version nothing is publishing any more (API `EXPIRED_STEP`). */
export const EXPIRED_STEP = 'publication_expired';

/**
 * Status of a history row, as the design names them (`REV_STATUS`). A rejection sends the
 * version back to draft with the reviewer's reason. An approved version whose publication never
 * finished is shown as failed: the API says it can be retried (`retryable`).
 */
export function historyStatus(review: Review): string {
  if (review.status === 'draft' && review.rejection_reason) return 'rejected';
  if (review.status === 'approved' && review.retryable) return 'failed';
  return review.status;
}

/**
 * Who decided a reviewed version: the email when the API has it. A decision taken before emails
 * were recorded only has the opaque user id (`internal`), which the design shows as such.
 */
export function reviewerOf(review: Review): { who: string; internal: boolean } | null {
  const status = historyStatus(review);
  const [email, id] =
    status === 'rejected'
      ? [review.rejected_by_email, review.rejected_by]
      : status === 'retired'
        ? [review.retired_by_email, review.retired_by]
        : [review.approved_by_email, review.approved_by];
  if (email) return { who: email, internal: false };
  return id ? { who: id, internal: true } : null;
}

/** Reason the reviewer gave (rejection or retirement), shown as text. */
export function reasonOf(review: Review): string | null {
  const status = historyStatus(review);
  if (status === 'rejected') return review.rejection_reason;
  if (status === 'retired') return review.retire_reason;
  return null;
}

/** Who wrote the version: the email when the API has it, else the opaque user id. */
export function authorOf(review: Pick<Review, 'created_by' | 'created_by_email'>): string {
  return review.created_by_email ?? review.created_by;
}

/** When a reviewed version was decided, for the history. */
export function decidedAt(review: Review): string | null {
  return review.decided_at ?? review.published_at ?? review.approved_at ?? review.submitted_at;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  draft: 'neutral',
  in_review: 'amber',
  rejected: 'red',
  approved: 'blue',
  published: 'green',
  failed: 'red',
  superseded: 'neutral',
  retired: 'neutral',
};
export type KnownStatus =
  | 'draft'
  | 'in_review'
  | 'rejected'
  | 'approved'
  | 'published'
  | 'failed'
  | 'superseded'
  | 'retired';

/** Design `REV_STATUS`. An unknown status is shown as its code, in neutral. */
export function statusTone(status: string): BadgeTone {
  return Object.hasOwn(STATUS_TONE, status) ? (STATUS_TONE[status] ?? 'neutral') : 'neutral';
}

export function isKnownStatus(status: string): status is KnownStatus {
  return Object.hasOwn(STATUS_TONE, status);
}

/**
 * Icons an agent can carry (design icons.jsx names), looked up as `AGENT_ICONS[name] ?? BotIcon`.
 * The name is API data: the map has no prototype, so `constructor` and the like are not icons.
 */
export const AGENT_ICONS: Readonly<Record<string, ComponentType<IconProps> | undefined>> =
  Object.assign(Object.create(null) as Record<string, ComponentType<IconProps> | undefined>, {
    Activity: ActivityIcon,
    BookOpen: BookOpenIcon,
    Bot: BotIcon,
    Chat: ChatIcon,
    Clock: ClockIcon,
    Cloud: CloudIcon,
    Eye: EyeIcon,
    Lock: LockIcon,
    Money: MoneyIcon,
    Search: SearchIcon,
    Settings: SettingsIcon,
    Shield: ShieldIcon,
    Skill: SkillIcon,
    Zap: ZapIcon,
  });

// --- Diff, as the backend computed it --------------------------------------------------------

export type FieldValue = string | number | null;

export function fieldChange(
  diff: Diff,
  field: string,
): { before: FieldValue; after: FieldValue } | null {
  return diff.fields.find((change) => change.field === field) ?? null;
}

const NO_SET = { added: [] as string[], removed: [] as string[] };

export function setChange(diff: Diff, field: string): { added: string[]; removed: string[] } {
  return diff.sets.find((change) => change.field === field) ?? NO_SET;
}

/** Fields and sets the detail shows in a section of its own; any other goes to "otros cambios". */
const SHOWN_FIELDS = new Set([
  'name',
  'description',
  'category',
  'icon',
  'color',
  'reports_to',
  'role',
  'model',
  'limits.max_tokens',
  'limits.max_iterations',
  'limits.timeout_seconds',
  'limits.max_tokens_per_call',
  'limits.temperature',
]);
const SHOWN_SETS = new Set(['allowed_models', 'tools', 'approval_tools', 'groups', 'users']);

/**
 * Changes the detail has no section for (a field added to the API later). They are listed as
 * they come, so a reviewer never approves a change that the screen did not show (TM-M2).
 */
export function otherChanges(diff: Diff): { fields: Diff['fields']; sets: Diff['sets'] } {
  return {
    fields: diff.fields.filter((change) => !SHOWN_FIELDS.has(change.field)),
    sets: diff.sets.filter((change) => !SHOWN_SETS.has(change.field)),
  };
}

// --- Reference data: names and labels only ---------------------------------------------------

export interface ToolInfo {
  dataTier: string;
  write: boolean;
  enabled: boolean;
}

export interface ReferenceData {
  /** Tools of the MCP catalog by reference; null while it is not known (no badges are shown). */
  tools: ReadonlyMap<string, ToolInfo> | null;
  /** Type of each registered group (`central`, `area`, `general`). */
  groupTypes: ReadonlyMap<string, string>;
  /** Names of the published agents, for "Reporta a". */
  agentNames: ReadonlyMap<string, string>;
}

export const NO_REFERENCE: ReferenceData = {
  tools: null,
  groupTypes: new Map(),
  agentNames: new Map(),
};

export function toolIndex(catalog: Catalog): Map<string, ToolInfo> {
  const tools = new Map<string, ToolInfo>();
  for (const connector of catalog.items) {
    for (const tool of connector.tools) {
      tools.set(tool.ref, {
        dataTier: connector.data_tier,
        write: tool.access === 'write',
        enabled: connector.enabled,
      });
    }
  }
  return tools;
}

export function groupTypeIndex(groups: Groups): Map<string, string> {
  return new Map(groups.items.map((group) => [group.id, group.type]));
}

export function agentNameIndex(org: Org): Map<string, string> {
  return new Map(org.nodes.map((node) => [node.id, node.name]));
}

// --- Errors ----------------------------------------------------------------------------------

export type ReviewErrorKey =
  | 'agentReview.errors.same_approver'
  | 'agentReview.errors.version_conflict'
  | 'agentReview.errors.validation_failed'
  | 'agentReview.errors.provisioner_unavailable'
  | 'agentReview.errors.audit_unavailable'
  | 'agentReview.errors.rules_unavailable'
  | 'agentReview.errors.forbidden'
  | 'agentReview.errors.not_found'
  | 'agentReview.errors.network'
  | 'agentReview.errors.generic';

const ERROR_BY_CODE: Record<string, ReviewErrorKey> = {
  same_approver: 'agentReview.errors.same_approver',
  version_conflict: 'agentReview.errors.version_conflict',
  validation_failed: 'agentReview.errors.validation_failed',
  provisioner_unavailable: 'agentReview.errors.provisioner_unavailable',
  audit_unavailable: 'agentReview.errors.audit_unavailable',
  models_unavailable: 'agentReview.errors.rules_unavailable',
  groups_unavailable: 'agentReview.errors.rules_unavailable',
  catalog_unavailable: 'agentReview.errors.rules_unavailable',
};

/** Message key of a failed decision. The server's `message` is never shown raw. */
export function reviewErrorKey(error: unknown): ReviewErrorKey {
  if (error instanceof ApiError) {
    if (Object.hasOwn(ERROR_BY_CODE, error.code)) {
      return ERROR_BY_CODE[error.code] ?? 'agentReview.errors.generic';
    }
    if (error.status === 409) return 'agentReview.errors.version_conflict';
    if (error.status === 403) return 'agentReview.errors.forbidden';
    if (error.status === 404) return 'agentReview.errors.not_found';
    return 'agentReview.errors.generic';
  }
  if (error instanceof TypeError) return 'agentReview.errors.network';
  return 'agentReview.errors.generic';
}

/** The version is no longer there to review (design «ya no está en revisión»). */
export function isGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** The data on screen is stale (decided by someone else, changed or gone): reload it. */
export function isStale(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 409 || error.status === 404 || error.code === 'validation_failed')
  );
}

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code !== 'same_approver';
}

/** Text of a submit rule: the API sends the code and the items, never the text. */
export function ruleText(t: TFunction, violation: Violation): string {
  return isRuleCode(violation.code)
    ? t(`agentReview.rules.${violation.code}`, { items: violation.items.join(', ') })
    : t('agentReview.rules.unknown', { code: violation.code });
}
