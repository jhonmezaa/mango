import type { OperationOutput } from '../../api/operations';

// Servicios externos (D93, D98; design remote-core.jsx). The API returns registrations, each with
// at most one pending request and its history; the design draws requests and registrations as
// rows of one list. This module maps one to the other. Nothing here authorizes: the API decides
// who may ask, approve or see what (Cedar `ManageRemoteMcp`, `ApproveRemoteMcp`).

export type RemoteCatalog = OperationOutput<'getRemoteCatalog'>;
export type RemoteProfile = RemoteCatalog['profiles'][number];
export type Registration = RemoteCatalog['registrations'][number];
export type RemoteRequest = NonNullable<Registration['pending']>;

/** The badge of a row (design `RmStatus`). */
export type RowStatus =
  | 'pending'
  | 'creating'
  | 'failed'
  | 'active'
  | 'secretExpired'
  | 'disabled'
  | 'rejected'
  | 'withdrawn';

/**
 * A row of the design: a registration, or a pending request on it. A request to change the
 * tenant or app of a live registration is its own row («Cambio de tenant o app»); the first
 * request of a registration is the registration itself («Pendiente de aprobación»).
 */
export interface Row {
  key: string;
  registration: Registration;
  request: RemoteRequest | null;
  status: RowStatus;
}

/** Ids of the API, checked again before they become a route or a request path. */
export const PROFILE_ID = /^[a-z][a-z0-9-]{1,23}$/;
export const REGISTRATION_ID = /^[a-z2-7]{12}$/;
/** D93 (5): the same pattern as the API (`mango_core.remote_mcp.ORGANIZATION_PATTERN`). */
export const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9-]{0,48}$/;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Limits of the API bodies (`RemoteRegistrationIn`, `Reason`). */
export const SECRET_MAX_LENGTH = 512;
export const REASON_MAX_LENGTH = 500;
export const MAX_GROUPS = 10;
/** The API takes a secret that expires two years ahead at most. */
export const MAX_SECRET_DAYS = 730;
/** Design: the form proposes an expiry six months ahead. */
export const DEFAULT_SECRET_DAYS = 180;

const DAY_MS = 86_400_000;

/** A `YYYY-MM-DD` date, as a local day. Anything else is `null`. */
export function parseDay(value: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whole days from today to `value` (negative once it passed), or `null`. */
export function daysUntil(
  value: string | null | undefined,
  now: number = Date.now(),
): number | null {
  const day = parseDay(value);
  if (!day) return null;
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((day.getTime() - start.getTime()) / DAY_MS);
}

/** `YYYY-MM-DD` of the local day `days` from today (the value of a date input). */
export function dayInput(days: number, now: number = Date.now()): string {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

const dayFormat = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Design `fmtDay`: «4 nov 2026». Unparseable input is returned unchanged (rendered as text). */
export function formatDay(value: string): string {
  const day = parseDay(value);
  return day ? dayFormat.format(day) : value;
}

/** Initials of the tile (design `short`, «AD»): the profile does not bring an icon. */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => word.charAt(0))
          .join('')
      : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

export function statusOf(registration: Registration): RowStatus {
  switch (registration.status) {
    case 'pending':
      return 'pending';
    case 'approved':
    case 'creating':
    case 'disabling':
      return 'creating';
    case 'failed':
      return 'failed';
    case 'disabled':
      return 'disabled';
    case 'active':
      return registration.secret_level === 'expired' ? 'secretExpired' : 'active';
  }
}

/**
 * What a failed registration says (design `FAIL`, round 25). The product only has platform codes:
 * a wrong datum of the app of Entra shows when people connect, not when the service is created.
 */
export type FailKind = 'platform' | 'unknown';

/** Failure codes with a text of their own: the ones the provisioner writes. */
const FAIL_KINDS = new Map<string, Exclude<FailKind, 'unknown'>>([
  ['target_timeout', 'platform'],
  ['target_failed', 'platform'],
]);

export interface FailInfo {
  kind: FailKind;
  /** Key under `remoteMcp.row.fail`: the code when it has a text, otherwise `unknown`. */
  title: string;
  /** The code as the API returned it (administrators only), shown as-is. */
  code: string | null;
}

export function failInfoOf(registration: Pick<Registration, 'failure_code'>): FailInfo {
  const code = registration.failure_code ?? null;
  const kind = code !== null ? FAIL_KINDS.get(code) : undefined;
  return kind && code !== null
    ? { kind, title: code, code }
    : { kind: 'unknown', title: 'unknown', code };
}

/** The request of a registration waiting for a decision (P-8 «Cambiar grupos» included). */
export function shownPending(registration: Registration): RemoteRequest | null {
  const pending = registration.pending ?? null;
  return pending && pending.status === 'pending' ? pending : null;
}

/** Rows of one profile (design `regsOf`), in the order the API lists them. */
export function rowsOf(catalog: RemoteCatalog, profileId: string): Row[] {
  return catalog.registrations
    .filter((registration) => registration.profile_id === profileId)
    .flatMap((registration) => {
      const pending = shownPending(registration);
      const status = statusOf(registration);
      const own: Row = {
        key: registration.id,
        registration,
        request: status === 'pending' ? pending : null,
        status,
      };
      if (status === 'pending' || !pending) return [own];
      return [
        own,
        {
          key: `${registration.id}:${pending.id}`,
          registration,
          request: pending,
          status: 'pending',
        },
      ];
    });
}

/** The row a key names (a registration, or `<registration>:<request>`). */
export function rowOf(rows: readonly Row[], key: string): Row | null {
  return rows.find((row) => row.key === key) ?? null;
}

export interface HistoryEntry {
  registration: Registration;
  request: RemoteRequest;
}

/** Design `histOf`: rejected and withdrawn requests, the most recent first. */
export function historyOf(catalog: RemoteCatalog, profileId: string): HistoryEntry[] {
  return catalog.registrations
    .filter((registration) => registration.profile_id === profileId)
    .flatMap((registration) =>
      (registration.history ?? [])
        .filter((request) => request.status === 'rejected' || request.status === 'withdrawn')
        .map((request) => ({ registration, request })),
    )
    .sort((a, b) => whenOf(b.request).localeCompare(whenOf(a.request)));
}

function whenOf(request: RemoteRequest): string {
  return request.decided_at ?? request.created_at;
}

/** Design `RemoteRequests` and the Bandeja: every request waiting for a decision. */
export function pendingRows(catalog: RemoteCatalog): Row[] {
  return catalog.profiles.flatMap((profile) =>
    rowsOf(catalog, profile.id).filter((row) => row.request !== null),
  );
}

/** The design's summary of a profile card: which row speaks for the profile. */
export function headlineOf(rows: readonly Row[]): Row | null {
  const by = (statuses: readonly RowStatus[]) => rows.find((row) => statuses.includes(row.status));
  return (
    by(['active', 'secretExpired']) ??
    by(['creating', 'failed']) ??
    rows.find((row) => row.status === 'pending' && row.registration.status === 'pending') ??
    by(['disabled']) ??
    null
  );
}

/** Rows for Ajustes › Conectividad (design `RemoteConnBlock`): what exists or is being made. */
export function settingsRows(catalog: RemoteCatalog): Row[] {
  return catalog.profiles.flatMap((profile) =>
    rowsOf(catalog, profile.id).filter((row) => row.request === null && row.status !== 'pending'),
  );
}

/** Rows with a status that changes on its own (the provisioner works): read again. */
export function isWorking(catalog: RemoteCatalog): boolean {
  return catalog.registrations.some((registration) => statusOf(registration) === 'creating');
}

export function toolsOf(profile: RemoteProfile, toolsets: readonly string[] | null = null) {
  return profile.toolsets.filter((toolset) => !toolsets || toolsets.includes(toolset.id));
}

export function toolCount(profile: RemoteProfile): number {
  return profile.toolsets.reduce((count, toolset) => count + toolset.tools.length, 0);
}

/** Who did something: «Tú» for the caller, else the e-mail, else the id (plain text). */
export function personOf(
  userId: string | null | undefined,
  email: string | null | undefined,
  me: string,
): string | null {
  if (!userId) return null;
  if (userId === me) return 'me';
  return email ?? userId;
}

// --- The form ---------------------------------------------------------------------------------

/** `params`: «Cambiar grupos» of an active registration (P-8, design round 24). */
export type FormKind = 'enable' | 'reenable' | 'replace_app' | 'params';

export interface RemoteForm {
  kind: FormKind;
  organization: string;
  tenantId: string;
  clientId: string;
  secret: string;
  secretExpiresOn: string;
  toolsets: string[];
  groups: string[];
}

export type FormField =
  'organization' | 'tenantId' | 'clientId' | 'secret' | 'secretExpiresOn' | 'toolsets' | 'groups';
export type FormErrors = Partial<Record<FormField, string>>;

/** Keys of `remoteMcp.form.errors`: what the design says under each field. */
export function formErrors(form: RemoteForm, now: number = Date.now()): FormErrors {
  const errors: FormErrors = {};
  if (form.kind === 'params') return groupErrors(form, errors);
  const organization = form.organization.trim();
  if (form.kind === 'enable') {
    if (!organization) errors.organization = 'organizationRequired';
    else if (/[/.:]/.test(organization)) errors.organization = 'organizationUrl';
    else if (!ORGANIZATION.test(organization)) errors.organization = 'organizationPattern';
  }
  if (!GUID.test(form.tenantId.trim())) errors.tenantId = 'guid';
  if (!GUID.test(form.clientId.trim())) errors.clientId = 'guid';
  if (!form.secret.trim()) errors.secret = 'secretRequired';
  else if (form.secret.length > SECRET_MAX_LENGTH) errors.secret = 'secretTooLong';
  const days = daysUntil(form.secretExpiresOn, now);
  if (days === null) errors.secretExpiresOn = 'expiryRequired';
  else if (days <= 0) errors.secretExpiresOn = 'expiryFuture';
  else if (days > MAX_SECRET_DAYS) errors.secretExpiresOn = 'expiryTooFar';
  return form.kind === 'replace_app' ? errors : groupErrors(form, errors);
}

function groupErrors(form: RemoteForm, errors: FormErrors): FormErrors {
  if (form.toolsets.length === 0) errors.toolsets = 'toolsetsRequired';
  if (form.groups.length === 0) errors.groups = 'groupsRequired';
  else if (form.groups.length > MAX_GROUPS) errors.groups = 'groupsTooMany';
  return errors;
}

/** «Cambiar grupos» with the same groups as now (design «No cambiaste ningún grupo.»). */
export function sameGroups(form: RemoteForm, registration: Registration): boolean {
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((item) => b.includes(item));
  return same(form.toolsets, registration.toolsets) && same(form.groups, registration.groups);
}

/** Design `diff` of «Cambiar grupos»: what is added, what is removed, what stays, in order. */
export function changeOf(
  before: readonly string[],
  after: readonly string[],
): { id: string; change: 'add' | 'remove' | null }[] {
  return [...new Set([...before, ...after])].map((id) => ({
    id,
    change: !before.includes(id) ? 'add' : !after.includes(id) ? 'remove' : null,
  }));
}

export function hasErrors(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Expiry of a secret to rotate (design `RotateModal`). */
export function expiryError(value: string, now: number = Date.now()): string | null {
  const days = daysUntil(value, now);
  if (days === null) return 'expiryRequired';
  if (days <= 0) return 'expiryFuture';
  if (days > MAX_SECRET_DAYS) return 'expiryTooFar';
  return null;
}

// --- Routes -----------------------------------------------------------------------------------

/** What `/mcp/remote/<profile>/<row>` opens. Untrusted input: only well-formed ids pass. */
export interface RemoteTarget {
  profile: string | null;
  row: string | null;
}

export function parseRemotePath(rest: string): RemoteTarget | null {
  const [tab, profile, row, request] = rest.split('/');
  if (tab !== 'remote') return null;
  if (!profile || !PROFILE_ID.test(profile)) return { profile: null, row: null };
  if (!row || !REGISTRATION_ID.test(row)) return { profile, row: null };
  return { profile, row: request && /^[0-9a-f]{32}$/.test(request) ? `${row}:${request}` : row };
}

/** The path that opens a profile or one of its rows in the catalog. */
export function remotePath(profile?: string, row?: Row): string {
  if (!profile) return '/mcp/remote';
  if (!row) return `/mcp/remote/${profile}`;
  return row.request && row.status === 'pending' && row.registration.status !== 'pending'
    ? `/mcp/remote/${profile}/${row.registration.id}/${row.request.id}`
    : `/mcp/remote/${profile}/${row.registration.id}`;
}
