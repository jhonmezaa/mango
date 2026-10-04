import { apiErrorCode } from '../../api/adminErrors';
import { ApiError } from '../../api/errors';

export type PeopleErrorKey =
  'people.errors.generic' | 'people.errors.last_admins' | 'people.errors.notPending';

/**
 * Message key of a refusal of the people API. The server's `message` is never shown: the codes
 * the design has a text for pick it, and anything else is the design's generic failure.
 */
export function peopleErrorKey(error: unknown): PeopleErrorKey {
  return apiErrorCode(error) === 'last_admins'
    ? 'people.errors.last_admins'
    : 'people.errors.generic';
}

/** Deciding on a change that is closed already (design `ChangeList`: 409 and 410). */
export function decisionErrorKey(error: unknown): PeopleErrorKey {
  if (error instanceof ApiError && (error.status === 409 || error.status === 410)) {
    return error.code === 'last_admins' ? 'people.errors.last_admins' : 'people.errors.notPending';
  }
  return peopleErrorKey(error);
}

export type InviteServerError = 'format' | 'publicDomain' | 'domain' | 'exists';

const INVITE_CODES: Record<string, InviteServerError> = {
  invalid_email: 'format',
  public_domain: 'publicDomain',
  domain_not_allowed: 'domain',
  already_exists: 'exists',
};

/** The refusals of an invitation the design has a text for; `null` is its generic failure. */
export function inviteServerError(error: unknown): InviteServerError | null {
  return INVITE_CODES[apiErrorCode(error) ?? ''] ?? null;
}
