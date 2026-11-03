import { CognitoError } from '../../auth/cognito/api';

/** Codes where the answer is "the code is wrong or expired". */
const CODE_ERRORS = new Set([
  'CodeMismatchException',
  'ExpiredCodeException',
  'EnableSoftwareTokenMFAException',
]);

/** Sign-in failures shown with the neutral credentials message (TM-L10). */
const CREDENTIAL_ERRORS = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
  'PasswordResetRequiredException',
]);

/**
 * Rejections of a call that sends an email (`ForgotPassword`, `ResendConfirmationCode`) that
 * are decided without looking at the account: the WAF of the user pool, the request rate of
 * the API, the network, or a failure of the service. Only these may be shown, because an
 * existing account and a missing one get the same answer (TM-L10).
 *
 * `LimitExceededException` is left out on purpose: it covers the per-user attempt limit and
 * the daily email quota, and the second is only reached when an email is really sent.
 * Anything not listed here is treated as sent.
 */
const SEND_REJECTIONS = new Set([
  'NetworkError',
  'ForbiddenException',
  'TooManyRequestsException',
  'InternalErrorException',
]);
/** The same rejections when the answer carries no Cognito exception name (WAF, proxy). */
const SEND_REJECTION_STATUS = /^Http(?:403|429|5\d\d)$/;

export function cognitoCode(error: unknown): string {
  return error instanceof CognitoError ? error.code : 'Unknown';
}

export function isSendRejection(error: unknown): boolean {
  const code = cognitoCode(error);
  return SEND_REJECTIONS.has(code) || SEND_REJECTION_STATUS.test(code);
}

/**
 * The rejection is the request rate (the API's `TooManyRequestsException` or a 429 of the WAF):
 * design round 34 «Demasiados intentos». Also decided without looking at the account; the
 * per-user `LimitExceededException` stays out (see `SEND_REJECTIONS`).
 */
export function isSendThrottled(error: unknown): boolean {
  const code = cognitoCode(error);
  return code === 'TooManyRequestsException' || code === 'Http429';
}

/** Design login.jsx round 34 `MAIL_ERR`: the text of a send rejection, by where it happened. */
export function mailErrorKey(
  where: 'send' | 'resend' | 'signup',
  error: unknown,
): `auth.mail.${typeof where}.${'fail' | 'throttle'}` {
  return `auth.mail.${where}.${isSendThrottled(error) ? 'throttle' : 'fail'}`;
}

export function isCodeError(error: unknown): boolean {
  return CODE_ERRORS.has(cognitoCode(error));
}

export function isCredentialError(error: unknown): boolean {
  return CREDENTIAL_ERRORS.has(cognitoCode(error));
}
