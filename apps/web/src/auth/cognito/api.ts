import { z } from 'zod';

/**
 * Minimal client for the public (unsigned) Cognito user pool API: a JSON POST with
 * `X-Amz-Target`. No AWS SDK: these operations need no credentials, and every dependency on
 * the login path handles passwords (TM-L1).
 *
 * - The destination is fixed by the validated runtime config (REACT-NET-001) and allowed by the
 *   CSP `connect-src`; no cookies or credentials are sent.
 * - Errors keep only Cognito's exception name: request and response bodies (passwords, codes,
 *   secrets, tokens) never reach an error message, the console or telemetry (TM-L12).
 */

export type CognitoOperation =
  | 'InitiateAuth'
  | 'RespondToAuthChallenge'
  | 'AssociateSoftwareToken'
  | 'VerifySoftwareToken'
  | 'SignUp'
  | 'ConfirmSignUp'
  | 'ResendConfirmationCode'
  | 'ForgotPassword'
  | 'ConfirmForgotPassword'
  | 'RevokeToken';

export class CognitoError extends Error {
  override name = 'CognitoError';

  /** @param code Cognito exception name, e.g. `NotAuthorizedException` (or `NetworkError`). */
  constructor(readonly code: string) {
    super(code);
  }
}

const errorSchema = z.object({ __type: z.string().max(200) });

export type CognitoCall = <T>(
  operation: CognitoOperation,
  body: Record<string, unknown>,
  schema: z.ZodType<T>,
) => Promise<T>;

export function createCognitoCall(endpoint: string, fetchImpl: typeof fetch = fetch): CognitoCall {
  return async function call<T>(
    operation: CognitoOperation,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`,
        },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new CognitoError('NetworkError');
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Empty or non-JSON body (RevokeToken answers `{}`; proxies may answer HTML).
    }
    if (!response.ok) {
      const parsed = errorSchema.safeParse(payload);
      // `__type` may be `com.amazonaws...#NotAuthorizedException` or the bare name.
      const code = parsed.success ? (parsed.data.__type.split('#').pop() ?? '') : '';
      throw new CognitoError(/^[A-Za-z]{1,100}$/.test(code) ? code : `Http${response.status}`);
    }
    const parsed = schema.safeParse(payload ?? {});
    if (!parsed.success) throw new CognitoError('InvalidResponse');
    return parsed.data;
  };
}
