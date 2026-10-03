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

export function cognitoCode(error: unknown): string {
  return error instanceof CognitoError ? error.code : 'Unknown';
}

export function isCodeError(error: unknown): boolean {
  return CODE_ERRORS.has(cognitoCode(error));
}

export function isCredentialError(error: unknown): boolean {
  return CREDENTIAL_ERRORS.has(cognitoCode(error));
}
