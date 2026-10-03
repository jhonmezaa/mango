/** Same shape check as the design (`isEmail`); the server decides everything else. */
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Mirrors the Cognito password policy in `infra/lib/constructs/identity.ts`. */
export const MIN_PASSWORD_LENGTH = 14;

/** Design `pwdScore`: one point per policy criterion (length, upper, lower, digit, symbol). */
export function passwordScore(password: string): 0 | 1 | 2 | 3 | 4 | 5 {
  return [
    password.length >= MIN_PASSWORD_LENGTH,
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length as 0 | 1 | 2 | 3 | 4 | 5;
}

export function meetsPasswordPolicy(password: string): boolean {
  return passwordScore(password) === 5;
}

/** Domain of an address the user typed, lowercased (UI hint only). */
export function domainOf(email: string): string {
  return (normalizeEmail(email).split('@')[1] ?? '').trim();
}

export const CODE_LENGTH = 6;
