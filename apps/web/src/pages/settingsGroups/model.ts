import type { OperationInput, OperationOutput } from '../../api/operations';

// Ajustes › Grupos: the registry of access groups and its change requests, as the generated
// client types them (packages/ts/api-client). Everything here is display logic: the API decides
// every rule again (REACT-AUTHZ-001).

export type GroupsAdmin = OperationOutput<'getAdminGroups'>;
export type Group = GroupsAdmin['items'][number];
export type GroupChange = GroupsAdmin['changes'][number];
export type GroupType = Group['type'];
export type Proposal = OperationInput<'postGroupChange'>['body'];

export const GROUP_TYPES: readonly GroupType[] = ['central', 'area', 'general'];
export type TypeFilter = 'all' | GroupType;
export const TYPE_FILTERS: readonly TypeFilter[] = ['all', ...GROUP_TYPES];

/** Design `TONE`. */
export const TYPE_BADGE: Record<GroupType, string> = {
  central: 'badge-violet',
  area: 'badge-amber',
  general: '',
};

/** Must match `CHANGE_LIFETIME` in `apps/api/src/mango_api/group_admin.py`. */
export const CHANGE_TTL_HOURS = 72;
export const DESCRIPTION_MAX_LENGTH = 200;
export const REASON_MAX_LENGTH = 500;
/** Must match `NEW_GROUP_NAME_PATTERN` in `mango_core.groups` (design: 2 to 32). */
const NEW_GROUP_NAME = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function isNewGroupName(value: string): boolean {
  return NEW_GROUP_NAME.test(value);
}

/** Must match `MAX_GROUPS` in `mango_core.groups`. */
export const MAX_GROUPS = 100;
/** Design `RESERVED`: system groups, and the `mango-` prefix the API reserves. */
const SYSTEM_GROUPS: ReadonlySet<string> = new Set([
  'mango-admin',
  'mango-agent-creator',
  'finops-central',
  'bu-lead',
]);

export function isReservedName(value: string): boolean {
  return SYSTEM_GROUPS.has(value) || value.startsWith('mango-');
}

/** `bu-<área>`: the name makes it an area group (`fixed_shape` in `mango_core.groups`). */
export function isAreaGroupName(value: string): boolean {
  return value.startsWith('bu-') && value !== 'bu-lead';
}

/** Design filter: type, then a text search over name, description and area. */
export function filterGroups(groups: readonly Group[], type: TypeFilter, query: string): Group[] {
  const needle = query.trim().toLowerCase();
  return groups.filter(
    (group) =>
      (type === 'all' || group.type === type) &&
      (!needle ||
        `${group.id} ${group.description} ${group.area ?? ''}`.toLowerCase().includes(needle)),
  );
}

export function countByType(groups: readonly Group[]): Record<TypeFilter, number> {
  const counts: Record<TypeFilter, number> = {
    all: groups.length,
    central: 0,
    area: 0,
    general: 0,
  };
  for (const group of groups) counts[group.type] += 1;
  return counts;
}

/** The open request of each group (the API keeps one per group). */
export function pendingByGroup(changes: readonly GroupChange[]): Map<string, GroupChange> {
  const pending = new Map<string, GroupChange>();
  for (const change of changes) {
    if (change.status === 'pending') pending.set(change.group_id, change);
  }
  return pending;
}

/** Agents that hold a group central: they use it with account-data tools. */
export function accountDataAgents(group: Group): Group['agents'] {
  return group.agents.filter((agent) => agent.account_data);
}

export interface GroupDraft {
  id: string;
  description: string;
  type: GroupType;
  area: string | null;
}

export const NEW_GROUP: GroupDraft = { id: '', description: '', type: 'general', area: null };

export function draftOf(group: Group): GroupDraft {
  return { id: group.id, description: group.description, type: group.type, area: group.area };
}

/** Changing the type or the area needs another administrator; the description does not. */
export function needsApproval(group: Group | null, draft: GroupDraft): boolean {
  if (!group) return true;
  const area = draft.type === 'area' ? draft.area : null;
  return draft.type !== group.type || area !== group.area;
}
