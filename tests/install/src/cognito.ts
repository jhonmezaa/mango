// What Cognito answers when it refuses the code of a sign-in, and the one retry that follows.
// Pure: nothing here touches a page, and nothing here ever holds the code or the password.

/** `X-Amz-Target` of the call that answers a sign-in challenge (the TOTP code among them). */
export const CHALLENGE_TARGET = 'AWSCognitoIdentityProviderService.RespondToAuthChallenge';

export interface Refusal {
  status: number;
  /** Cognito exception name (`CodeMismatchException`), or `Http<status>` when it gives none. */
  name: string;
}

/** The code itself was refused: wrong for this window, or already used in it. */
const CODE_REFUSALS: ReadonlySet<string> = new Set([
  'CodeMismatchException',
  'ExpiredCodeException',
]);

const HINTS: Readonly<Record<string, string>> = {
  NotAuthorizedException: 'the sign-in attempt expired or Cognito ended it',
  TooManyRequestsException: 'the request rate of the user pool was exceeded',
  LimitExceededException: 'the attempt limit of this user was exceeded',
  ForbiddenException: 'the WAF of the user pool blocked the request',
  Http403: 'the WAF of the user pool blocked the request',
  Http429: 'the request rate of the user pool was exceeded',
};

/**
 * Reads a refused answer of Cognito. Only the exception name is kept, and only if it looks
 * like one: the rest of the body never reaches a message.
 */
export function refusalOf(status: number, body: unknown): Refusal {
  const type =
    typeof body === 'object' && body !== null && '__type' in body ? body.__type : undefined;
  // `__type` may be `com.amazonaws…#CodeMismatchException` or the bare name.
  const name = typeof type === 'string' ? (type.split('#').pop() ?? '') : '';
  return { status, name: /^[A-Za-z]{1,100}$/.test(name) ? name : `Http${status}` };
}

export function isCodeRefusal(refusal: Refusal): boolean {
  return CODE_REFUSALS.has(refusal.name);
}

/** The failure message of a sign-in Cognito refused at the code step, after `attempts` codes. */
export function describeRefusal(refusal: Refusal, attempts: 1 | 2): string {
  if (!isCodeRefusal(refusal)) {
    const hint = HINTS[refusal.name];
    return (
      `Cognito refused the sign-in at the code step (${refusal.name})` +
      `${hint ? `: ${hint}` : ''}. It was not tried again.`
    );
  }
  return (
    `Cognito refused the TOTP code (${refusal.name})` +
    `${attempts === 2 ? ' twice, in two different 30 s windows' : ''}. Probable cause: ` +
    'another process is signing in as this same test user (another script or another run; ' +
    'wait a minute and run again), the TOTP secret of this user in the secrets file is not ' +
    'the one registered in the user pool, or the clock of this machine is off.'
  );
}

export type Attempt<T, R extends Refusal = Refusal> =
  { ok: true; value: T } | { ok: false; refusal: R };

/**
 * Runs a sign-in attempt and, if Cognito refuses its code, exactly one more: never a loop.
 * Any other refusal fails at once. `onCodeRefused` runs between the two attempts.
 */
export async function withOneRetry<T, R extends Refusal>(
  attempt: () => Promise<Attempt<T, R>>,
  onCodeRefused: (refusal: R) => void,
): Promise<T> {
  const first = await attempt();
  if (first.ok) return first.value;
  if (!isCodeRefusal(first.refusal)) throw new Error(describeRefusal(first.refusal, 1));
  onCodeRefused(first.refusal);
  const second = await attempt();
  if (second.ok) return second.value;
  throw new Error(describeRefusal(second.refusal, 2));
}
