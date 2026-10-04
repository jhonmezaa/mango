/**
 * Mock of Cognito: user pool API (own login, D20) and managed login (SSO). The app runs its real
 * SRP and OAuth code + PKCE flows against these endpoints; there is no auth bypass in the
 * application code.
 *
 * Own login in the mock: the SRP proof is checked for shape only (the math is covered by
 * the vectors in `srp.test.ts`), so any password signs in. The email picks the path:
 * `mfa@…` asks for a TOTP code, `enroll@…` enrolls TOTP, `temp@…` has a temporary password
 * (NEW_PASSWORD_REQUIRED, "Crea tu contraseña"), `nogroup@…` and accounts created with
 * "Crear cuenta" have no group. Verification and recovery codes are `123456`; TOTP codes are any
 * six digits except `000000`.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { originOf, readBody, redirect, sendError, sendJson } from './http.ts';

export const MOCK_USER = 'mock-user@example.com';
/** The mock admin belongs to this area, so the "own area" rules (D17) can be tried. */
export const MOCK_USER_AREA = 'finanzas';

const codes = new Map<string, { challenge: string; redirectUri: string }>();
const accessTokens = new Set<string>();
const refreshTokens = new Set<string>();
/** Access and refresh tokens of users without a group (403 `no_group`, D20). */
const noGroupTokens = new Set<string>();
const MOCK_CODE = '123456';
const registered = new Map<string, { confirmed: boolean }>();
const sessions = new Map<
  string,
  { email: string; next: 'mfa' | 'enroll' | 'newPassword' | 'done' }
>();

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url(JSON.stringify(payload))}.mock`;
}

/** Session of a request to the mock API, from its bearer token. */
export function sessionOf(req: IncomingMessage): 'ok' | 'no_group' | null {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ') || !accessTokens.has(auth.slice(7))) return null;
  return noGroupTokens.has(auth.slice(7)) ? 'no_group' : 'ok';
}

function issueTokens(
  origin: string,
  withRefresh: boolean,
  noGroup = false,
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const issuer = `${origin}/mock-cognito`;
  const accessToken = fakeJwt({
    sub: 'mock-sub',
    iss: issuer,
    client_id: 'mockclient',
    token_use: 'access',
    ...(noGroup ? {} : { mango_role: 'finops-central' }),
    exp: now + 3600,
    iat: now,
    jti: randomUUID(),
  });
  accessTokens.add(accessToken);
  if (noGroup) noGroupTokens.add(accessToken);
  const tokens: Record<string, unknown> = {
    access_token: accessToken,
    id_token: fakeJwt({
      sub: 'mock-sub',
      iss: issuer,
      aud: 'mockclient',
      token_use: 'id',
      email: MOCK_USER,
      exp: now + 3600,
      iat: now,
    }),
    token_type: 'Bearer',
    expires_in: 3600,
  };
  if (withRefresh) {
    const refreshToken = randomBytes(24).toString('hex');
    refreshTokens.add(refreshToken);
    if (noGroup) noGroupTokens.add(refreshToken);
    tokens.refresh_token = refreshToken;
  }
  return tokens;
}

// --- Cognito user pool API (own login, D20) ----------------------------------------------

interface MockReply {
  status: number;
  body: unknown;
}
/** What mango-api does with a refresh token for the session cookie (D63). */
export function renewFromRefreshToken(
  origin: string,
  refreshToken: string,
): { access_token: string; id_token: string; expires_in: number } | null {
  if (!refreshTokens.has(refreshToken)) return null;
  const result = authResult(
    origin,
    MOCK_USER,
    noGroupTokens.has(refreshToken),
    refreshToken,
  ).AuthenticationResult;
  return { access_token: str(result.AccessToken), id_token: result.IdToken, expires_in: 3600 };
}

export function revokeRefreshToken(refreshToken: string): void {
  refreshTokens.delete(refreshToken);
}

const ok = (body: unknown): MockReply => ({ status: 200, body });
const fail = (type: string): MockReply => ({ status: 400, body: { __type: type, message: type } });
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function authResult(origin: string, email: string, noGroup: boolean, refreshToken?: string) {
  const tokens = issueTokens(origin, refreshToken === undefined, noGroup);
  const now = Math.floor(Date.now() / 1000);
  return {
    AuthenticationResult: {
      AccessToken: tokens.access_token,
      IdToken: fakeJwt({ sub: 'mock-sub', email, token_use: 'id', iat: now, exp: now + 3600 }),
      ...(refreshToken === undefined ? { RefreshToken: tokens.refresh_token } : {}),
      ExpiresIn: 3600,
      TokenType: 'Bearer',
    },
  };
}

const isNoGroup = (email: string) => email.startsWith('nogroup@') || registered.has(email);

function nextSession(email: string, next: 'mfa' | 'enroll' | 'newPassword' | 'done'): string {
  const session = randomBytes(24).toString('base64url');
  sessions.set(session, { email, next });
  return session;
}

export async function handleCognitoApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const target = str(req.headers['x-amz-target']).replace('AWSCognitoIdentityProviderService.', '');
  const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  const reply = cognitoApi(originOf(req), target, body);
  sendJson(res, reply.status, reply.body);
}

function cognitoApi(origin: string, target: string, body: Record<string, unknown>): MockReply {
  const params = (body.AuthParameters ?? {}) as Record<string, string>;
  const responses = (body.ChallengeResponses ?? {}) as Record<string, string>;
  const email = (str(body.Username) || (params.USERNAME ?? '')).toLowerCase();
  const code =
    str(body.ConfirmationCode) || str(body.UserCode) || (responses.SOFTWARE_TOKEN_MFA_CODE ?? '');
  const session = sessions.get(str(body.Session));
  switch (target) {
    case 'InitiateAuth': {
      if (body.AuthFlow === 'REFRESH_TOKEN_AUTH') {
        const refresh = params.REFRESH_TOKEN ?? '';
        if (!refreshTokens.has(refresh)) return fail('NotAuthorizedException');
        return ok(authResult(origin, MOCK_USER, noGroupTokens.has(refresh), refresh));
      }
      if (body.AuthFlow !== 'USER_SRP_AUTH' || !/^[0-9a-f]{700,}$/.test(params.SRP_A ?? '')) {
        return fail('InvalidParameterException');
      }
      if (registered.get(email)?.confirmed === false) {
        return fail('UserNotConfirmedException');
      }
      return ok({
        ChallengeName: 'PASSWORD_VERIFIER',
        ChallengeParameters: {
          USER_ID_FOR_SRP: email,
          USERNAME: email,
          SALT: randomBytes(16).toString('hex'),
          SRP_B: randomBytes(384).toString('hex'),
          SECRET_BLOCK: randomBytes(64).toString('base64'),
        },
      });
    }
    case 'RespondToAuthChallenge': {
      if (body.ChallengeName === 'PASSWORD_VERIFIER') {
        const user = responses.USERNAME ?? '';
        if (!/^[A-Za-z0-9+/]{43}=$/.test(responses.PASSWORD_CLAIM_SIGNATURE ?? '')) {
          return fail('NotAuthorizedException');
        }
        if (user.startsWith('mfa@')) {
          return ok({
            ChallengeName: 'SOFTWARE_TOKEN_MFA',
            Session: nextSession(user, 'mfa'),
            ChallengeParameters: {},
          });
        }
        if (user.startsWith('temp@')) {
          return ok({
            ChallengeName: 'NEW_PASSWORD_REQUIRED',
            Session: nextSession(user, 'newPassword'),
            ChallengeParameters: {},
          });
        }
        if (user.startsWith('enroll@')) {
          return ok({
            ChallengeName: 'MFA_SETUP',
            Session: nextSession(user, 'enroll'),
            ChallengeParameters: {},
          });
        }
        return ok(authResult(origin, user, isNoGroup(user)));
      }
      if (!session) return fail('NotAuthorizedException');
      sessions.delete(str(body.Session));
      if (body.ChallengeName === 'SOFTWARE_TOKEN_MFA') {
        if (!/^\d{6}$/.test(code) || code === '000000') {
          sessions.set(str(body.Session), session);
          return fail('CodeMismatchException');
        }
        return ok(authResult(origin, session.email, isNoGroup(session.email)));
      }
      if (body.ChallengeName === 'NEW_PASSWORD_REQUIRED' && session.next === 'newPassword') {
        return ok(authResult(origin, session.email, isNoGroup(session.email)));
      }
      if (body.ChallengeName === 'MFA_SETUP' && session.next === 'done') {
        return ok(authResult(origin, session.email, isNoGroup(session.email)));
      }
      return fail('NotAuthorizedException');
    }
    case 'AssociateSoftwareToken':
      if (!session || session.next !== 'enroll') return fail('NotAuthorizedException');
      sessions.delete(str(body.Session));
      // Base32 of random bytes, like Cognito's SecretCode.
      return ok({
        SecretCode: Array.from(
          randomBytes(32),
          (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b % 32],
        ).join(''),
        Session: nextSession(session.email, 'enroll'),
      });
    case 'VerifySoftwareToken':
      if (!session) return fail('NotAuthorizedException');
      if (!/^\d{6}$/.test(code) || code === '000000') return fail('CodeMismatchException');
      sessions.delete(str(body.Session));
      return ok({ Status: 'SUCCESS', Session: nextSession(session.email, 'done') });
    case 'SignUp':
      if (!email.endsWith('@example.com')) return fail('UserLambdaValidationException');
      if (registered.has(email)) return fail('UsernameExistsException');
      registered.set(email, { confirmed: false });
      return ok({ UserConfirmed: false, UserSub: randomUUID() });
    case 'ConfirmSignUp':
      if (code !== MOCK_CODE || !registered.has(email)) return fail('CodeMismatchException');
      registered.set(email, { confirmed: true });
      return ok({});
    case 'ConfirmForgotPassword':
      if (code !== MOCK_CODE) return fail('CodeMismatchException');
      return ok({});
    case 'ResendConfirmationCode':
    case 'ForgotPassword':
      // Same answer whether or not the account exists (PreventUserExistenceErrors).
      return ok({ CodeDeliveryDetails: { DeliveryMedium: 'EMAIL' } });
    case 'RevokeToken':
      refreshTokens.delete(str(body.Token));
      return ok({});
    default:
      return fail('InvalidParameterException');
  }
}

export async function handleCognito(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const origin = originOf(req);
  const path = url.pathname.replace('/mock-cognito', '');
  if (path === '/oauth2/authorize' && req.method === 'GET') {
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const challenge = url.searchParams.get('code_challenge') ?? '';
    if (
      !redirectUri.startsWith(`${origin}/`) ||
      url.searchParams.get('code_challenge_method') !== 'S256' ||
      !challenge
    ) {
      sendError(res, 400, 'invalid_request', 'redirect_uri or PKCE parameters are invalid');
      return;
    }
    const code = randomBytes(16).toString('hex');
    codes.set(code, { challenge, redirectUri });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', url.searchParams.get('state') ?? '');
    redirect(res, target.toString());
    return;
  }
  if (path === '/oauth2/token' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    if (form.get('grant_type') === 'authorization_code') {
      const entry = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const computed = createHash('sha256').update(verifier).digest('base64url');
      if (
        !entry ||
        entry.challenge !== computed ||
        entry.redirectUri !== form.get('redirect_uri')
      ) {
        sendJson(res, 400, { error: 'invalid_grant' });
        return;
      }
      sendJson(res, 200, issueTokens(origin, true));
      return;
    }
    if (
      form.get('grant_type') === 'refresh_token' &&
      refreshTokens.has(form.get('refresh_token') ?? '')
    ) {
      // Cognito does not rotate refresh tokens: the response has no refresh_token.
      sendJson(res, 200, issueTokens(origin, false));
      return;
    }
    sendJson(res, 400, { error: 'invalid_grant' });
    return;
  }
  if (path === '/oauth2/revoke' && req.method === 'POST') {
    refreshTokens.delete(new URLSearchParams(await readBody(req)).get('token') ?? '');
    res.statusCode = 200;
    res.end();
    return;
  }
  if (path === '/logout' && req.method === 'GET') {
    const logoutUri = url.searchParams.get('logout_uri') ?? '';
    redirect(res, logoutUri.startsWith(`${origin}/`) ? logoutUri : `${origin}/`);
    return;
  }
  sendError(res, 404, 'not_found', 'Not found');
}
