import { apiErrorCode } from '../../api/adminErrors';
import { ApiError } from '../../api/errors';

export type PeopleErrorKey =
  | 'people.errors.generic'
  | 'people.errors.last_admins'
  | 'people.errors.notPending'
  | 'people.errors.busy'
  | 'people.errors.forbidden'
  | `people.errors.approve.${ApproveRefusal}`;

/** The rules the API checks again when a change is approved (design `recheck`). */
const APPROVE_REFUSALS = [
  'user_disabled',
  'already_member',
  // The person has the maximum of groups: one has to go first; the change stays pending.
  'too_many_groups',
  'last_admins',
  // The change no longer applies (design: «retíralo o recházalo»).
  'unknown_group',
  'not_member',
  'already_disabled',
  'already_enabled',
] as const;
type ApproveRefusal = (typeof APPROVE_REFUSALS)[number];

/** The caller stopped being an administrator with the session still open (design `forbidden`). */
function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === 'forbidden';
}

/**
 * Message key of a refusal of the people API. The server's `message` is never shown: the codes
 * the design has a text for pick it, and anything else is the design's generic failure. `busy` is
 * another change of administrators in progress; on a change applied at once, `version_conflict`
 * is the administrators having changed meanwhile, and trying again is the answer too.
 */
export function peopleErrorKey(error: unknown): PeopleErrorKey {
  const code = apiErrorCode(error);
  if (code === 'last_admins') return 'people.errors.last_admins';
  if (code === 'busy' || code === 'version_conflict') return 'people.errors.busy';
  return isForbidden(error) ? 'people.errors.forbidden' : 'people.errors.generic';
}

/**
 * Deciding on a change: it is closed already (design `ChangeList`: 409 and 410), another change
 * of administrators is being applied (`busy`: the change is still pending), or approving it broke
 * a rule that is checked again and the change stays pending.
 */
export function decisionErrorKey(error: unknown, approving = false): PeopleErrorKey {
  // `unknown_group` is a 422: the group of the change was removed after it was proposed.
  if (approving && error instanceof ApiError && error.code === 'unknown_group') {
    return 'people.errors.approve.unknown_group';
  }
  if (error instanceof ApiError && (error.status === 409 || error.status === 410)) {
    if (error.code === 'busy') return 'people.errors.busy';
    const refusal = APPROVE_REFUSALS.find((code) => code === error.code);
    if (approving && refusal) return `people.errors.approve.${refusal}`;
    return error.code === 'last_admins' ? 'people.errors.last_admins' : 'people.errors.notPending';
  }
  return isForbidden(error) ? 'people.errors.forbidden' : 'people.errors.generic';
}

export type InviteServerError = 'format' | 'publicDomain' | 'exists';

const INVITE_CODES: Record<string, InviteServerError> = {
  invalid_email: 'format',
  public_domain: 'publicDomain',
  already_exists: 'exists',
};

/** The refusals of an invitation the design has a text for; `null` is its generic failure. */
export function inviteServerError(error: unknown): InviteServerError | null {
  return INVITE_CODES[apiErrorCode(error) ?? ''] ?? null;
}
