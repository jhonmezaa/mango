import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Challenge, SignInStep } from '../auth/cognito/flows';
import { useAuth } from '../auth/useAuth';
import type { RuntimeConfig } from '../config/runtimeConfig';
import { CodeStep } from './login/CodeStep';
import { cognitoCode, isCredentialError, isSendRejection } from './login/errors';
import { ForgotStep } from './login/ForgotStep';
import { LoginLayout } from './login/LoginLayout';
import { MfaEnroll } from './login/MfaEnroll';
import { NewPasswordStep } from './login/NewPasswordStep';
import { ResetStep } from './login/PasswordCodeStep';
import { Bold } from './login/rich';
import { SignInForm } from './login/SignInForm';
import { SignUpForm } from './login/SignUpForm';
import { normalizeEmail } from './login/validation';

type Step = 'login' | 'mfa' | 'enroll' | 'newPassword' | 'signup' | 'verify' | 'forgot' | 'reset';

/** A Cognito challenge session expired or was already used: start over (not a code error). */
const SESSION_LOST = 'NotAuthorizedException';

/**
 * Own login (D20, design `login.jsx`): SRP sign-in, TOTP, sign-up with email verification,
 * password recovery and SSO. Threat model: `login-threat-model.md` (TM-L1, TM-L10, TM-L12).
 *
 * - Passwords and codes stay in component state; nothing goes to storage, the URL, the console
 *   or telemetry. The sign-up password is kept in a ref only until the verified account signs
 *   in, so verification can continue straight into MFA enrollment.
 * - Messages never reveal whether an email has an account.
 */
export function LoginPage({ config }: { config: RuntimeConfig }) {
  const { t } = useTranslation();
  const { cognito, acceptTokens, ssoAvailable, startSso, errorKey, noticeKey } = useAuth();
  const [step, setStep] = useState<Step>('login');
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState<string | null>(() =>
    noticeKey ? t(noticeKey as 'auth.signedOutElsewhere') : null,
  );
  const [error, setError] = useState<string | null>(() =>
    errorKey ? t(errorKey as 'auth.errors.signInFailed') : null,
  );
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const pendingPassword = useRef<string | null>(null);
  const domain = config.signUpDomains[0] ?? '';

  const go = (next: Step, message: string | null = null) => {
    setStep(next);
    setNotice(message);
    setError(null);
  };

  const backToLogin = useCallback(() => {
    pendingPassword.current = null;
    setChallenge(null);
    setNotice(null);
    setError(t('auth.errors.signInFailed'));
    setStep('login');
  }, [t]);

  const handleStep = (result: SignInStep) => {
    pendingPassword.current = null;
    if (result.kind === 'done') {
      acceptTokens(result.tokens);
      return;
    }
    setChallenge(result.challenge);
    go(result.kind === 'mfa' ? 'mfa' : result.kind === 'mfaSetup' ? 'enroll' : 'newPassword');
  };

  /** Runs a challenge response; an expired session goes back to the sign-in form. */
  const respond = async (run: () => Promise<SignInStep>) => {
    try {
      handleStep(await run());
    } catch (e) {
      if (cognitoCode(e) === SESSION_LOST) {
        backToLogin();
        return;
      }
      throw e;
    }
  };

  const signIn = async (address: string, password: string): Promise<string | null> => {
    const username = normalizeEmail(address);
    try {
      handleStep(await cognito.signIn(username, password));
      return null;
    } catch (e) {
      if (cognitoCode(e) === 'UserNotConfirmedException') {
        // Only reachable with the right password: finish the verification first.
        pendingPassword.current = password;
        setEmail(username);
        await cognito.resendCode(username).catch(() => undefined);
        go('verify');
        return null;
      }
      return isCredentialError(e) ? t('auth.errors.credentials') : t('auth.errors.signInFailed');
    }
  };

  const signUp = async (fields: { name: string; email: string; password: string }) => {
    try {
      await cognito.signUp(fields.email, fields.password, fields.name);
    } catch (e) {
      // Same answer for an existing account (TM-L10); anything else is shown by the form.
      if (cognitoCode(e) !== 'UsernameExistsException') throw e;
    }
    pendingPassword.current = fields.password;
    setEmail(fields.email);
    go('verify');
  };

  const verify = async (code: string) => {
    await cognito.confirmSignUp(email, code);
    const password = pendingPassword.current;
    if (!password) {
      go('login');
      return;
    }
    await respond(() => cognito.signIn(email, password));
  };

  const forgot = async (address: string) => {
    const username = normalizeEmail(address);
    setEmail(username);
    try {
      await cognito.forgotPassword(username);
    } catch (e) {
      // Not sent for a reason that does not depend on the account: the form says so.
      if (isSendRejection(e)) throw e;
    }
    // Same next step whether or not the account exists (TM-L10).
    go('reset');
  };

  const footer =
    step === 'login' || step === 'signup' ? (
      <p className="login-foot">
        {step === 'login' ? t('auth.noAccount') : t('auth.haveAccount')}{' '}
        <button
          type="button"
          className="login-foot-link"
          onClick={() => {
            go(step === 'login' ? 'signup' : 'login');
          }}
        >
          {step === 'login' ? t('auth.createAccount') : t('auth.signInLink')}
        </button>
      </p>
    ) : null;

  return (
    <LoginLayout footer={footer}>
      {step === 'login' && (
        <SignInForm
          email={email}
          onEmailChange={setEmail}
          domain={domain}
          sessionHours={config.auth.sessionHours}
          notice={notice}
          error={error}
          ssoAvailable={ssoAvailable}
          onForgot={() => {
            go('forgot');
          }}
          onSubmit={signIn}
          onSso={startSso}
        />
      )}
      {step === 'mfa' && challenge && (
        <CodeStep
          title={t('auth.mfa.title')}
          subtitle={t('auth.mfa.subtitle')}
          cta={t('auth.mfa.submit')}
          label={t('auth.mfa.label')}
          backLabel={t('auth.mfa.otherAccount')}
          onBack={() => {
            go('login');
          }}
          onSubmit={(code) => respond(() => cognito.respondMfa(challenge, code))}
        />
      )}
      {step === 'enroll' && challenge && (
        <MfaEnroll
          cognito={cognito}
          challenge={challenge}
          email={email}
          onDone={handleStep}
          onBack={() => {
            go('login');
          }}
          onSessionLost={backToLogin}
        />
      )}
      {step === 'newPassword' && challenge && (
        <NewPasswordStep
          subtitle={
            <Bold
              translate={(slot) => t('auth.newPassword.subtitle', { email: slot })}
              value={email}
            />
          }
          onBack={() => {
            go('login');
          }}
          onSubmit={(password) => respond(() => cognito.respondNewPassword(challenge, password))}
        />
      )}
      {step === 'signup' && (
        <SignUpForm
          domains={config.signUpDomains}
          aiPolicyUrl={config.aiPolicyUrl}
          onSubmit={signUp}
        />
      )}
      {step === 'verify' && (
        <CodeStep
          title={t('auth.verify.title')}
          subtitle={
            <Bold translate={(slot) => t('auth.verify.subtitle', { email: slot })} value={email} />
          }
          cta={t('auth.verify.submit')}
          backLabel={t('auth.verify.back')}
          onBack={() => {
            pendingPassword.current = null;
            go('signup');
          }}
          onResend={() => cognito.resendCode(email)}
          onSubmit={verify}
        />
      )}
      {step === 'forgot' && (
        <ForgotStep
          email={email}
          onEmailChange={setEmail}
          onBack={() => {
            go('login');
          }}
          onSubmit={forgot}
        />
      )}
      {step === 'reset' && (
        <ResetStep
          subtitle={
            <Bold translate={(slot) => t('auth.reset.subtitle', { email: slot })} value={email} />
          }
          onBack={() => {
            go('forgot');
          }}
          onResend={() => cognito.forgotPassword(email)}
          onSubmit={async (code, password) => {
            await cognito.confirmForgotPassword(email, code, password);
            go('login', t('auth.passwordUpdated'));
          }}
        />
      )}
    </LoginLayout>
  );
}
