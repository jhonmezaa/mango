import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { CognitoError, type CognitoCall, type CognitoOperation } from './api';
import { CognitoAuth } from './flows';

const NOW = new Date('2026-09-30T12:00:00Z');
const PASSWORD = 'Correct-Horse-Battery-9!';

type Handler = (body: Record<string, unknown>) => unknown;

function fakeCognito(handlers: Partial<Record<string, Handler | Handler[]>>) {
  const requests: { operation: CognitoOperation; body: Record<string, unknown> }[] = [];
  const call: CognitoCall = <T>(
    operation: CognitoOperation,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
  ) => {
    requests.push({ operation, body });
    const entry = handlers[operation];
    const handler = Array.isArray(entry) ? entry.shift() : entry;
    if (!handler) return Promise.reject(new CognitoError('Unexpected'));
    try {
      return Promise.resolve(schema.parse(handler(body)));
    } catch (e) {
      return Promise.reject(e instanceof CognitoError ? e : new CognitoError('InvalidResponse'));
    }
  };
  const auth = new CognitoAuth({
    call,
    clientId: 'client',
    userPoolId: 'us-east-1_Pool',
    now: () => NOW,
  });
  return { auth, requests };
}

const verifier = () => ({
  ChallengeName: 'PASSWORD_VERIFIER',
  ChallengeParameters: {
    USER_ID_FOR_SRP: 'uuid-1',
    USERNAME: 'uuid-1',
    SALT: '0a1b2c3d',
    SRP_B: 'ab'.repeat(200),
    SECRET_BLOCK: btoa('block'),
  },
});
const result = { AccessToken: 'a.b.c', IdToken: 'i.d.t', RefreshToken: 'r', ExpiresIn: 3600 };

describe('CognitoAuth', () => {
  it('signs in with SRP and never sends the password', async () => {
    const { auth, requests } = fakeCognito({
      InitiateAuth: verifier,
      RespondToAuthChallenge: () => ({ AuthenticationResult: result }),
    });
    const step = await auth.signIn('usuario1@empresa.com', PASSWORD);
    expect(step).toEqual({
      kind: 'done',
      tokens: {
        accessToken: 'a.b.c',
        idToken: 'i.d.t',
        refreshToken: 'r',
        expiresAt: NOW.getTime() + 3_600_000,
      },
    });
    const [init, respond] = requests;
    expect(init?.body).toMatchObject({
      AuthFlow: 'USER_SRP_AUTH',
      ClientId: 'client',
      AuthParameters: { USERNAME: 'usuario1@empresa.com' },
    });
    expect(respond?.body).toMatchObject({
      ChallengeName: 'PASSWORD_VERIFIER',
      ChallengeResponses: {
        USERNAME: 'uuid-1',
        TIMESTAMP: 'Wed Sep 30 12:00:00 UTC 2026',
        PASSWORD_CLAIM_SECRET_BLOCK: btoa('block'),
      },
    });
    expect(JSON.stringify(requests)).not.toContain(PASSWORD);
    expect(JSON.stringify(requests)).not.toContain('USER_PASSWORD_AUTH');
  });

  it.each([
    ['SOFTWARE_TOKEN_MFA', 'mfa'],
    ['MFA_SETUP', 'mfaSetup'],
    ['NEW_PASSWORD_REQUIRED', 'newPassword'],
  ])('maps the %s challenge', async (name, kind) => {
    const { auth } = fakeCognito({
      InitiateAuth: verifier,
      RespondToAuthChallenge: () => ({
        ChallengeName: name,
        Session: 's1',
        ChallengeParameters: {},
      }),
    });
    expect(await auth.signIn('u@empresa.com', PASSWORD)).toEqual({
      kind,
      challenge: { username: 'uuid-1', session: 's1' },
    });
  });

  it.each(['SMS_MFA', 'SELECT_MFA_TYPE', 'CUSTOM_CHALLENGE', 'EMAIL_OTP'])(
    'refuses the unsupported %s challenge',
    async (name) => {
      const { auth } = fakeCognito({
        InitiateAuth: verifier,
        RespondToAuthChallenge: () => ({ ChallengeName: name, Session: 's1' }),
      });
      await expect(auth.signIn('u@empresa.com', PASSWORD)).rejects.toMatchObject({
        code: 'UnsupportedChallenge',
      });
    },
  );

  it('enrolls TOTP with the MFA_SETUP session, never an access token', async () => {
    const { auth, requests } = fakeCognito({
      AssociateSoftwareToken: () => ({
        SecretCode: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        Session: 's2',
      }),
      VerifySoftwareToken: () => ({ Status: 'SUCCESS', Session: 's3' }),
      RespondToAuthChallenge: () => ({ AuthenticationResult: result }),
    });
    const setup = await auth.beginMfaSetup({ username: 'uuid-1', session: 's1' });
    expect(setup.secret).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    const step = await auth.completeMfaSetup(setup.challenge, '123456');
    expect(step.kind).toBe('done');
    expect(requests.map((r) => r.body)).toEqual([
      { Session: 's1' },
      { Session: 's2', UserCode: '123456', FriendlyDeviceName: 'Mango' },
      {
        ClientId: 'client',
        ChallengeName: 'MFA_SETUP',
        Session: 's3',
        ChallengeResponses: { USERNAME: 'uuid-1' },
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain('AccessToken');
  });

  it('treats a failed TOTP verification as a wrong code', async () => {
    const { auth } = fakeCognito({ VerifySoftwareToken: () => ({ Status: 'ERROR' }) });
    await expect(
      auth.completeMfaSetup({ username: 'u', session: 's' }, '000000'),
    ).rejects.toMatchObject({
      code: 'CodeMismatchException',
    });
  });

  it('refreshes keeping the refresh token and revokes it on sign-out', async () => {
    const { auth, requests } = fakeCognito({
      InitiateAuth: () => ({ AuthenticationResult: { ...result, RefreshToken: undefined } }),
      RevokeToken: () => ({}),
    });
    const tokens = await auth.refresh('r-1');
    expect(tokens.refreshToken).toBe('r-1');
    await auth.revoke('r-1');
    expect(requests.map((r) => r.body)).toEqual([
      {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: 'client',
        AuthParameters: { REFRESH_TOKEN: 'r-1' },
      },
      { ClientId: 'client', Token: 'r-1' },
    ]);
  });

  it('signs up with email and display name only', async () => {
    const { auth, requests } = fakeCognito({ SignUp: () => ({ UserConfirmed: false }) });
    await auth.signUp('u@empresa.com', PASSWORD, 'Usuario 1');
    expect(requests[0]?.body).toEqual({
      ClientId: 'client',
      Username: 'u@empresa.com',
      Password: PASSWORD,
      UserAttributes: [
        { Name: 'email', Value: 'u@empresa.com' },
        { Name: 'name', Value: 'Usuario 1' },
      ],
    });
  });

  it('rejects malformed challenge parameters', async () => {
    const { auth } = fakeCognito({
      InitiateAuth: () => ({
        ChallengeName: 'PASSWORD_VERIFIER',
        ChallengeParameters: { SALT: 'zz' },
      }),
    });
    await expect(auth.signIn('u@empresa.com', PASSWORD)).rejects.toMatchObject({
      code: 'InvalidResponse',
    });
    vi.restoreAllMocks();
  });
});
