import { z } from 'zod';

import { CognitoError, type CognitoCall } from './api';
import { cognitoTimestamp, passwordClaim, startSession } from './srp';

/**
 * Own login against Cognito (D20): SRP sign-in, TOTP challenge and enrollment, sign-up with
 * email verification, password recovery, refresh and revocation. Never `USER_PASSWORD_AUTH`.
 *
 * Passwords and codes only pass through these function arguments; nothing is kept here.
 */

const MAX_TOKEN = 16_384;
const token = z.string().min(1).max(MAX_TOKEN);

const authResultSchema = z.object({
  AccessToken: token,
  IdToken: token,
  RefreshToken: token.optional(),
  ExpiresIn: z.number().int().positive().max(86_400),
});

const challengeSchema = z.object({
  AuthenticationResult: authResultSchema.optional(),
  ChallengeName: z.string().max(64).optional(),
  ChallengeParameters: z.record(z.string(), z.string()).optional(),
  Session: z.string().min(1).max(MAX_TOKEN).optional(),
});

const passwordVerifierSchema = z.object({
  USER_ID_FOR_SRP: z.string().min(1).max(256),
  SALT: z.string().regex(/^[0-9a-fA-F]{1,1024}$/),
  SRP_B: z.string().regex(/^[0-9a-fA-F]{1,2048}$/),
  SECRET_BLOCK: z.string().min(1).max(MAX_TOKEN),
  USERNAME: z.string().min(1).max(256).optional(),
});

const associateSchema = z.object({
  // Base32 TOTP secret.
  SecretCode: z.string().regex(/^[A-Z2-7]{16,128}=*$/),
  Session: z.string().min(1).max(MAX_TOKEN).optional(),
});
const verifySchema = z.object({
  Status: z.enum(['SUCCESS', 'ERROR']),
  Session: z.string().min(1).max(MAX_TOKEN).optional(),
});
const empty = z.object({}).loose();

export interface TokenSet {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
}

export interface Challenge {
  username: string;
  session: string;
}

export type SignInStep =
  | { kind: 'done'; tokens: TokenSet }
  | { kind: 'mfa'; challenge: Challenge }
  | { kind: 'mfaSetup'; challenge: Challenge }
  | { kind: 'newPassword'; challenge: Challenge };

export interface CognitoAuthOptions {
  call: CognitoCall;
  clientId: string;
  userPoolId: string;
  now?: () => Date;
}

function tokensFrom(
  result: z.infer<typeof authResultSchema>,
  now: Date,
  refreshToken?: string,
): TokenSet {
  const refresh = result.RefreshToken ?? refreshToken;
  if (!refresh) throw new CognitoError('InvalidResponse');
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    refreshToken: refresh,
    expiresAt: now.getTime() + result.ExpiresIn * 1000,
  };
}

export class CognitoAuth {
  private readonly call: CognitoCall;
  private readonly clientId: string;
  private readonly userPoolId: string;
  private readonly now: () => Date;

  constructor(options: CognitoAuthOptions) {
    this.call = options.call;
    this.clientId = options.clientId;
    this.userPoolId = options.userPoolId;
    this.now = options.now ?? (() => new Date());
  }

  private step(response: z.infer<typeof challengeSchema>, username: string): SignInStep {
    if (response.AuthenticationResult) {
      return { kind: 'done', tokens: tokensFrom(response.AuthenticationResult, this.now()) };
    }
    const session = response.Session;
    const name = response.ChallengeParameters?.USER_ID_FOR_SRP ?? username;
    if (!session) throw new CognitoError('InvalidResponse');
    const challenge = { username: name, session };
    switch (response.ChallengeName) {
      case 'SOFTWARE_TOKEN_MFA':
        return { kind: 'mfa', challenge };
      case 'MFA_SETUP':
        return { kind: 'mfaSetup', challenge };
      case 'NEW_PASSWORD_REQUIRED':
        return { kind: 'newPassword', challenge };
      default:
        // SMS, email OTP, custom or device challenges are not enabled for this client.
        throw new CognitoError('UnsupportedChallenge');
    }
  }

  private respond(
    name: string,
    challenge: Challenge,
    responses: Record<string, string>,
  ): Promise<z.infer<typeof challengeSchema>> {
    return this.call(
      'RespondToAuthChallenge',
      {
        ClientId: this.clientId,
        ChallengeName: name,
        Session: challenge.session,
        ChallengeResponses: { USERNAME: challenge.username, ...responses },
      },
      challengeSchema,
    );
  }

  /** `USER_SRP_AUTH` + `PASSWORD_VERIFIER`. */
  async signIn(email: string, password: string): Promise<SignInStep> {
    const srp = startSession();
    const init = await this.call(
      'InitiateAuth',
      {
        AuthFlow: 'USER_SRP_AUTH',
        ClientId: this.clientId,
        AuthParameters: { USERNAME: email, SRP_A: srp.largeA },
      },
      challengeSchema,
    );
    if (init.ChallengeName !== 'PASSWORD_VERIFIER') throw new CognitoError('UnsupportedChallenge');
    const params = passwordVerifierSchema.safeParse(init.ChallengeParameters);
    if (!params.success) throw new CognitoError('InvalidResponse');
    const p = params.data;
    const timestamp = cognitoTimestamp(this.now());
    const signature = await passwordClaim(
      srp,
      this.userPoolId,
      { userIdForSrp: p.USER_ID_FOR_SRP, salt: p.SALT, srpB: p.SRP_B, secretBlock: p.SECRET_BLOCK },
      password,
      timestamp,
    );
    const username = p.USERNAME ?? p.USER_ID_FOR_SRP;
    const response = await this.call(
      'RespondToAuthChallenge',
      {
        ClientId: this.clientId,
        ChallengeName: 'PASSWORD_VERIFIER',
        ...(init.Session ? { Session: init.Session } : {}),
        ChallengeResponses: {
          USERNAME: username,
          PASSWORD_CLAIM_SECRET_BLOCK: p.SECRET_BLOCK,
          PASSWORD_CLAIM_SIGNATURE: signature,
          TIMESTAMP: timestamp,
        },
      },
      challengeSchema,
    );
    return this.step(response, username);
  }

  async respondMfa(challenge: Challenge, code: string): Promise<SignInStep> {
    const response = await this.respond('SOFTWARE_TOKEN_MFA', challenge, {
      SOFTWARE_TOKEN_MFA_CODE: code,
    });
    return this.step(response, challenge.username);
  }

  /**
   * Starts TOTP enrollment with the `MFA_SETUP` session (no access token: the self-service
   * scope is suppressed, TM-L2). The secret must stay in component memory only.
   */
  async beginMfaSetup(challenge: Challenge): Promise<{ secret: string; challenge: Challenge }> {
    const response = await this.call(
      'AssociateSoftwareToken',
      { Session: challenge.session },
      associateSchema,
    );
    return {
      secret: response.SecretCode,
      challenge: { ...challenge, session: response.Session ?? challenge.session },
    };
  }

  async completeMfaSetup(challenge: Challenge, code: string): Promise<SignInStep> {
    const verified = await this.call(
      'VerifySoftwareToken',
      { Session: challenge.session, UserCode: code, FriendlyDeviceName: 'Mango' },
      verifySchema,
    );
    if (verified.Status !== 'SUCCESS') throw new CognitoError('CodeMismatchException');
    const response = await this.respond(
      'MFA_SETUP',
      {
        ...challenge,
        session: verified.Session ?? challenge.session,
      },
      {},
    );
    return this.step(response, challenge.username);
  }

  async respondNewPassword(challenge: Challenge, password: string): Promise<SignInStep> {
    const response = await this.respond('NEW_PASSWORD_REQUIRED', challenge, {
      NEW_PASSWORD: password,
    });
    return this.step(response, challenge.username);
  }

  async signUp(email: string, password: string, name: string): Promise<void> {
    await this.call(
      'SignUp',
      {
        ClientId: this.clientId,
        Username: email,
        Password: password,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'name', Value: name },
        ],
      },
      empty,
    );
  }

  async confirmSignUp(email: string, code: string): Promise<void> {
    await this.call(
      'ConfirmSignUp',
      { ClientId: this.clientId, Username: email, ConfirmationCode: code },
      empty,
    );
  }

  async resendCode(email: string): Promise<void> {
    await this.call('ResendConfirmationCode', { ClientId: this.clientId, Username: email }, empty);
  }

  async forgotPassword(email: string): Promise<void> {
    await this.call('ForgotPassword', { ClientId: this.clientId, Username: email }, empty);
  }

  async confirmForgotPassword(email: string, code: string, password: string): Promise<void> {
    await this.call(
      'ConfirmForgotPassword',
      { ClientId: this.clientId, Username: email, ConfirmationCode: code, Password: password },
      empty,
    );
  }

  /** New access and ID tokens; the pre-token trigger runs again, so group changes apply. */
  async refresh(refreshToken: string): Promise<TokenSet> {
    const response = await this.call(
      'InitiateAuth',
      {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: this.clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      },
      challengeSchema,
    );
    if (!response.AuthenticationResult) throw new CognitoError('InvalidResponse');
    return tokensFrom(response.AuthenticationResult, this.now(), refreshToken);
  }

  /** Revokes the refresh token and the access tokens issued from it (token revocation). */
  async revoke(refreshToken: string): Promise<void> {
    await this.call('RevokeToken', { ClientId: this.clientId, Token: refreshToken }, empty);
  }
}
