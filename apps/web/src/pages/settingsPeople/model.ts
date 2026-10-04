import type { OperationInput, OperationOutput } from '../../api/operations';
import type { Me } from '../../api/schemas';
import type { GroupsAdmin } from '../settingsGroups/model';

// Ajustes › Personas: the directory and the changes of its people, as the generated client types
// them (packages/ts/api-client). Everything here is display logic: the API decides what needs a
// second administrator and answers `applied`, `proposed` or `bootstrap` (REACT-AUTHZ-001).

export type People = OperationOutput<'searchPeople'>;
export type Person = People['items'][number];
export type MemberChange = OperationOutput<'getMemberChanges'>['items'][number];
export type ActionResult = OperationOutput<'addGroup'>['result'];
export type ListFilter = NonNullable<OperationInput<'searchPeople'>['body']['filter']>;

export const FILTERS: readonly ListFilter[] = ['all', 'pending', 'invited', 'disabled'];

/** Must match `SENSITIVE_GROUPS` in `apps/api/src/mango_api/people.py`. Only labels the UI. */
const SENSITIVE_GROUPS: ReadonlySet<string> = new Set(['mango-admin', 'finops-central']);
export const ADMIN_GROUP = 'mango-admin';
/** Design `SYS_ORDER`; must match `SYSTEM_GROUPS` in `people.py`. */
export const SYSTEM_GROUPS: readonly string[] = [
  'mango-admin',
  'mango-agent-creator',
  'finops-central',
  'bu-lead',
];
/** Must match `CHANGE_LIFETIME` in `people.py` (D28). */
export const CHANGE_TTL_HOURS = 72;
export const REASON_MAX_LENGTH = 500;
/** Must match `_PREFIX_PATTERN` in `people.py`: what a search prefix may contain. */
const PREFIX = /^[a-z0-9._%+@-]{1,64}$/;
/** Design `InviteModal`. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_MAX = 254;

export function isSensitive(group: string): boolean {
  return SENSITIVE_GROUPS.has(group);
}

/**
 * Design `isExternal`: the domain is not one of those that sign up alone, so the person was
 * invited from another company. Only a label: without the list of domains nobody is marked.
 */
export function isExternal(email: string, domains: readonly string[]): boolean {
  return domains.length > 0 && !domains.includes(email.slice(email.lastIndexOf('@') + 1));
}

/** Signed up, can sign in and belongs to no group (design `noAccess`). */
export function hasNoAccess(person: Person): boolean {
  return person.status === 'active' && person.groups.length === 0;
}

/** Design `isAdminP`. */
export function isEnabledAdmin(person: Person): boolean {
  return person.status !== 'disabled' && person.groups.includes(ADMIN_GROUP);
}

/** Same test as the API (`_is_self`): the identifier or the email of the session. */
export function isSelf(me: Me, target: { user_id: string; email: string }): boolean {
  const own = me.email?.toLowerCase();
  return me.user_id === target.user_id || (Boolean(own) && own === target.email.toLowerCase());
}

/**
 * What the search sends as `prefix`: `null` without a search, `undefined` when what was typed
 * cannot start any email of the directory (nothing is asked then).
 */
export function searchPrefix(query: string): string | null | undefined {
  const value = query.trim().toLowerCase();
  if (value === '') return null;
  return PREFIX.test(value) ? value : undefined;
}

export type InviteError = 'empty' | 'format';

/**
 * Design `InviteModal` `err`, for what the screen can tell by itself: an empty or malformed
 * address. An administrator may invite someone of another company; whether the domain is a
 * public mail provider is the API's to say (`invitation_domain`, the list of
 * `mango_core.mail_domains`): the screen keeps no copy of that list, and a refusal there is in
 * the audit trail. The design checks the public providers in the modal; the text shown is the
 * same one.
 */
export function inviteError(email: string): InviteError | null {
  if (email === '') return 'empty';
  return email.length > EMAIL_MAX || !EMAIL.test(email) ? 'format' : null;
}

export interface GroupOption {
  id: string;
  system: boolean;
  type: 'central' | 'area' | 'general';
  area: string | null;
  description: string;
}

/** Design `GROUP_SEED`: the type of the system groups the registry does not list. */
const SYSTEM_TYPES: Record<string, GroupOption['type']> = {
  'mango-admin': 'central',
  'mango-agent-creator': 'general',
  'finops-central': 'central',
  'bu-lead': 'general',
};

/**
 * Groups a person can be given: the system ones and the registry (the API's `_assignable`), in
 * the design's order: system groups first (`SYS_ORDER`), then by name.
 */
export function groupOptions(registry: GroupsAdmin['items'] | null): GroupOption[] {
  const options = new Map<string, GroupOption>(
    SYSTEM_GROUPS.map((id) => [
      id,
      { id, system: true, type: SYSTEM_TYPES[id] ?? 'general', area: null, description: '' },
    ]),
  );
  for (const group of registry ?? []) {
    options.set(group.id, {
      id: group.id,
      system: SYSTEM_GROUPS.includes(group.id),
      type: group.type,
      area: group.area,
      description: group.description,
    });
  }
  const order = (id: string) => {
    const index = SYSTEM_GROUPS.indexOf(id);
    return index < 0 ? SYSTEM_GROUPS.length : index;
  };
  return [...options.values()].sort(
    (a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id),
  );
}

/** Open changes of one person, newest first (the API keeps one per person and change). */
export function pendingOf(changes: readonly MemberChange[], userId: string): MemberChange[] {
  return changes.filter((change) => change.status === 'pending' && change.target_user === userId);
}

const joined = new Intl.DateTimeFormat('es-MX', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Design `fmtDate`. Unparseable input is returned unchanged (it is rendered as text). */
export function formatJoined(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : joined.format(date);
}

export interface FirstDayFacts {
  admins: number;
  /** Enabled people with a group who are not administrators. */
  withAccess: number;
  /** Areas of the mapping and groups of the registry that are not system ones; `null` when
   * they could not be read. */
  areas: number | null;
  ownGroups: number | null;
}

/**
 * Whether a step of the first day is still missing (design `FirstDay`): the card is shown
 * while any step is, and not at all once they are done. A count that could
 * not be read does not show the card by itself.
 */
export function hasFirstDaySteps(facts: FirstDayFacts): boolean {
  return facts.admins < 2 || facts.withAccess === 0 || facts.areas === 0 || facts.ownGroups === 0;
}
