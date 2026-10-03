import { adminErrorKey, apiErrorCode, type AdminErrorKey } from '../../api/adminErrors';

const OWN_CODES = [
  'group_exists',
  'already_pending',
  'central_in_use',
  'reserved_name',
  'fixed_type',
  'system_group',
  'group_referenced',
  'unknown_area',
  'self_edit',
  'too_many_groups',
  'upstream_error',
] as const;
type OwnCode = (typeof OWN_CODES)[number];
export type GroupErrorKey = `groups.errors.${OwnCode | 'notPending'}` | AdminErrorKey;

function isOwn(code: string | null): code is OwnCode {
  return code !== null && (OWN_CODES as readonly string[]).includes(code);
}

/**
 * Message key of a refusal of the groups API. The server's `message` is never shown: the code
 * picks a text of the app, and anything unknown falls back to the admin messages.
 */
export function groupErrorKey(error: unknown): GroupErrorKey {
  const code = apiErrorCode(error);
  return isOwn(code) ? `groups.errors.${code}` : adminErrorKey(error);
}

/** Deciding on a request that is closed already (design `ChangeList`). */
export function decisionErrorKey(error: unknown): GroupErrorKey {
  const code = apiErrorCode(error);
  if (code === 'version_conflict' || code === 'expired') return 'groups.errors.notPending';
  return groupErrorKey(error);
}
