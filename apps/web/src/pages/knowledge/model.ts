import type { OperationOutput } from '../../api/operations';
import type { knowledge as texts } from '../../i18n/locales/es/knowledge';
import { findSecrets } from '../agentBuilder/model';

// Knowledge Bases (design kb-core.jsx, D88): what the screen shows of each knowledge base, read
// from what the API answers. Nothing here authorizes: `can_edit`, `can_view_documents` and
// `can_search` are the API's hints and every request is authorized again (REACT-AUTHZ-001).

export type KnowledgeBase = OperationOutput<'listKnowledgeBases'>['items'][number];
export type KnowledgeList = OperationOutput<'listKnowledgeBases'>;
export type Source = OperationOutput<'listSources'>['items'][number];
export type Origin = KnowledgeBase['origin'];
export type Schedule = KnowledgeBase['sync_schedule'];

/** Design `KB_ST`: the status shown, from the stored one, its sources and why it stopped. */
export type ShownStatus =
  | 'ok'
  | 'warn'
  | 'full'
  | 'error'
  | 'syncing'
  | 'pending'
  | 'approval'
  | 'rejected'
  | 'nosource'
  | 'blocked'
  | 'deleting';

export const SCHEDULES: readonly Schedule[] = ['manual', '6h', 'daily', 'weekly'];
export const DEFAULT_SCHEDULE: Schedule = 'daily';
/** Design `KB.ATTN` and `KB.UNSYNCED`. `full` is a warning (D88 (43)): it needs attention. */
const ATTENTION: ReadonlySet<ShownStatus> = new Set([
  'warn',
  'full',
  'error',
  'rejected',
  'blocked',
  'nosource',
]);
const UNSYNCED: ReadonlySet<ShownStatus> = new Set(['pending', 'approval']);
const BADGES: Record<ShownStatus, string> = {
  ok: 'badge-green',
  warn: 'badge-amber',
  full: 'badge-amber',
  error: 'badge-red',
  syncing: 'badge-blue',
  pending: '',
  approval: 'badge-amber',
  rejected: 'badge-red',
  nosource: '',
  blocked: 'badge-amber',
  deleting: '',
};

export type StatusFilter = 'all' | 'attention' | 'unsynced';
export type OriginFilter = 'all' | Origin;
export const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'attention', 'unsynced'];
export const ORIGIN_FILTERS: readonly OriginFilter[] = ['all', 'upload', 'bucket'];
export const QUERY_MAX_LENGTH = 100;
export const NAME_MAX_LENGTH = 48;
export const DESCRIPTION_MAX_LENGTH = 140;
/** Design `KB_LIMITS`: what one knowledge base holds (D88). */
export const LIMITS = { documents: 1000, bytes: 5e9 } as const;

/** The active sources of a bucket knowledge base: one approved, maybe one proposed (D88 (42)). */
function sourcesOf(kb: KnowledgeBase) {
  const sources = kb.sources ?? [];
  return {
    approved: sources.find((s) => s.status === 'approved') ?? null,
    pending: sources.find((s) => s.status === 'pending') ?? null,
    decided: sources.find((s) => s.status === 'rejected' || s.status === 'withdrawn') ?? null,
  };
}

export function shownStatus(kb: KnowledgeBase): ShownStatus {
  if (kb.status === 'deleting') return 'deleting';
  if (kb.sync_running || kb.status === 'syncing') return 'syncing';
  if (kb.origin === 'bucket' && kb.sources !== null) {
    const { approved, pending, decided } = sourcesOf(kb);
    if (!approved) {
      if (pending) return 'approval';
      return decided?.status === 'rejected' ? 'rejected' : 'nosource';
    }
  }
  if (kb.status_reason === 'budget') return 'blocked';
  if (kb.status_reason === 'full') return 'full';
  if (kb.status_reason === 'error') return 'error';
  return kb.status;
}

export type StatusKey = keyof typeof texts.status;
/** Errors of the API with a text of their own on this screen. */
export type ErrorKey = keyof typeof texts.errors;

/** The i18n key of the badge: files that are uploaded are «indexed», never «synchronized». */
export function statusKey(kb: KnowledgeBase, status: ShownStatus = shownStatus(kb)): StatusKey {
  if (kb.origin === 'upload' && (status === 'ok' || status === 'syncing' || status === 'pending'))
    return `${status}Upload`;
  return status;
}

export function isErrorKey(code: string | null, own: ReadonlySet<string>): code is ErrorKey {
  return code !== null && own.has(code);
}

export function badgeClass(status: ShownStatus): string {
  const tone = BADGES[status];
  return tone ? `badge ${tone}` : 'badge';
}

export function isSpinning(status: ShownStatus): boolean {
  return status === 'syncing' || status === 'deleting';
}

export function inFilter(status: ShownStatus, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  return (filter === 'attention' ? ATTENTION : UNSYNCED).has(status);
}

export function needsAttention(status: ShownStatus): boolean {
  return ATTENTION.has(status);
}

export interface Filters {
  query: string;
  status: StatusFilter;
  origin: OriginFilter;
}

export const NO_FILTERS: Filters = { query: '', status: 'all', origin: 'all' };

function ownerName(kb: KnowledgeBase): string {
  return kb.owner.name ?? kb.owner.email ?? kb.owner.user_id;
}

/** Design: search by name, description and owner; then the origin; the status filter last. */
export function searched(items: readonly KnowledgeBase[], filters: Filters): KnowledgeBase[] {
  const query = filters.query.trim().toLowerCase();
  return items.filter(
    (kb) =>
      (filters.origin === 'all' || kb.origin === filters.origin) &&
      (!query || `${kb.name} ${kb.description} ${ownerName(kb)}`.toLowerCase().includes(query)),
  );
}

export function filtered(items: readonly KnowledgeBase[], filters: Filters): KnowledgeBase[] {
  return searched(items, filters).filter((kb) => inFilter(shownStatus(kb), filters.status));
}

export { ownerName };

/** Agents whose groups are not all in the knowledge base (D26 «Acceso parcial», D88 (26)). */
export function partialAgents(kb: KnowledgeBase) {
  return (kb.agents ?? []).filter((agent) => (agent.groups_without_access ?? []).length > 0);
}

export function activeSources(kb: KnowledgeBase) {
  return sourcesOf(kb);
}

/** The location shown for a bucket knowledge base: the approved one, else the proposed one. */
export function shownLocation(kb: KnowledgeBase): string | null {
  const { approved, pending, decided } = sourcesOf(kb);
  return (approved ?? pending ?? decided)?.location ?? null;
}

// --- Numbers ----------------------------------------------------------------------------------

const integer = new Intl.NumberFormat('es-ES', { useGrouping: 'always' });
const decimal = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
const money = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Design `kbN`: 1.000 with the grouping always on. */
export function formatCount(value: number): string {
  return integer.format(value);
}

/** Design `kbBytes`. */
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 MB';
  if (bytes >= 1e9) return `${decimal.format(bytes / 1e9)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** Design `kbUsd`: «USD 12,40». The API sends a decimal string. */
export function formatEstimate(usd: string): string | null {
  const value = Number(usd);
  return Number.isFinite(value) ? `USD ${money.format(value)}` : null;
}

// --- Forms ------------------------------------------------------------------------------------

const LOCATION = /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](\/\S*)?$/;

/** Design `kbRefErr`: only the shape; the API checks the bucket itself. */
export function locationError(value: string): 'ref' | 'refFormat' | null {
  const location = value.trim();
  if (!location) return 'ref';
  return LOCATION.test(location) ? null : 'refFormat';
}

export function hasSecret(...values: string[]): boolean {
  return values.some((value) => findSecrets(value).length > 0);
}

export function sameGroups(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}
