import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthContext, type AuthContextValue } from '../auth/AuthContext';
import { CognitoError } from '../auth/cognito/api';
import type { CognitoAuth, SignInStep } from '../auth/cognito/flows';
import { SLIDE_INTERVAL_MS } from '../components/LoginCarousel';
import type { RuntimeConfig } from '../config/runtimeConfig';
import { authValue } from '../test/fixtures';
import * as totp from './login/totp';
import { LoginPage } from './LoginPage';

// The real QR, behind a spy so one test can hold it back.
vi.mock('./login/totp', async (importOriginal) => {
  const actual = await importOriginal<typeof totp>();
  return { ...actual, qrMatrix: vi.fn(actual.qrMatrix) };
});

const config = {
  region: 'us-east-1',
  cognitoDomain: 'https://auth.example.com',
  userPoolId: 'us-east-1_Test',
  clientId: 'client',
  apiBasePath: '/api',
  signUpDomains: ['empresa.com'],
  auth: { installationType: 'customer', mfa: 'required', sessionHours: 12 },
} as RuntimeConfig;

const PASSWORD = 'Correct-Horse-Battery-9!';
const tokens = {
  accessToken: 'a',
  idToken: 'i',
  refreshToken: 'r',
  expiresAt: Date.now() + 3_600_000,
};
const challenge = { username: 'uuid-1', session: 's1' };
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const QR_NAME = 'Código QR para la app autenticadora';

function fakeCognito(overrides: Partial<Record<keyof CognitoAuth, unknown>> = {}) {
  return {
    signIn: vi.fn(() => Promise.resolve<SignInStep>({ kind: 'done', tokens })),
    respondMfa: vi.fn(() => Promise.resolve<SignInStep>({ kind: 'done', tokens })),
    beginMfaSetup: vi.fn(() =>
      Promise.resolve({ secret: SECRET, challenge: { ...challenge, session: 's2' } }),
    ),
    completeMfaSetup: vi.fn(() => Promise.resolve<SignInStep>({ kind: 'done', tokens })),
    respondNewPassword: vi.fn(() => Promise.resolve<SignInStep>({ kind: 'done', tokens })),
    signUp: vi.fn(() => Promise.resolve()),
    confirmSignUp: vi.fn(() => Promise.resolve()),
    resendCode: vi.fn(() => Promise.resolve()),
    forgotPassword: vi.fn(() => Promise.resolve()),
    confirmForgotPassword: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(),
    revoke: vi.fn(),
    ...overrides,
  };
}

function renderLogin(
  cognito = fakeCognito(),
  overrides: Partial<AuthContextValue> = {},
  runtimeConfig: RuntimeConfig = config,
) {
  const auth = authValue({
    status: 'unauthenticated',
    cognito: cognito as unknown as CognitoAuth,
    ...overrides,
  });
  render(
    <AuthContext value={auth}>
      <LoginPage config={runtimeConfig} />
    </AuthContext>,
  );
  return { auth, cognito, user: userEvent.setup() };
}

async function signIn(user: ReturnType<typeof userEvent.setup>, email = 'usuario1@empresa.com') {
  await user.type(screen.getByPlaceholderText('Correo · usuario1@empresa.com'), email);
  await user.type(screen.getByLabelText('Contraseña'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Entrar' }));
}

async function typeCode(user: ReturnType<typeof userEvent.setup>, code = '123456') {
  await user.click(screen.getByLabelText('Dígito 1'));
  await user.paste(code);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LoginPage: sign-in', () => {
  it('renders the design form and never stores anything', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { auth, cognito, user } = renderLogin();
    expect(screen.getByRole('heading', { name: 'Bienvenido' })).toBeInTheDocument();
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.queryByRole('button', { name: 'Continuar con SSO' })).toBeNull();
    await signIn(user, ' Usuario1@Empresa.com ');
    expect(cognito.signIn).toHaveBeenCalledWith('usuario1@empresa.com', PASSWORD);
    expect(auth.acceptTokens).toHaveBeenCalledWith(tokens);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('asks for both fields before calling Cognito', async () => {
    const { cognito, user } = renderLogin();
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Escribe tu correo y tu contraseña.');
    expect(cognito.signIn).not.toHaveBeenCalled();
  });

  it.each(['NotAuthorizedException', 'UserNotFoundException'])(
    'shows the same message for %s (no user enumeration)',
    async (code) => {
      const cognito = fakeCognito({ signIn: vi.fn(() => Promise.reject(new CognitoError(code))) });
      const { user } = renderLogin(cognito);
      await signIn(user);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Correo o contraseña incorrectos.',
      );
      expect(screen.getByLabelText('Contraseña')).toHaveValue('');
    },
  );

  it('verifies the TOTP code and signs in', async () => {
    const cognito = fakeCognito({
      signIn: vi.fn(() => Promise.resolve<SignInStep>({ kind: 'mfa', challenge })),
    });
    const { auth, user } = renderLogin(cognito);
    await signIn(user);
    expect(
      await screen.findByRole('heading', { name: 'Verificación en dos pasos' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reenviar código' })).toBeNull();
    await typeCode(user);
    await user.click(screen.getByRole('button', { name: 'Verificar y entrar' }));
    expect(cognito.respondMfa).toHaveBeenCalledWith(challenge, '123456');
    expect(auth.acceptTokens).toHaveBeenCalledWith(tokens);
  });

  it('shows the design error for a wrong TOTP code', async () => {
    const cognito = fakeCognito({
      signIn: vi.fn(() => Promise.resolve<SignInStep>({ kind: 'mfa', challenge })),
      respondMfa: vi.fn(() => Promise.reject(new CognitoError('CodeMismatchException'))),
    });
    const { user } = renderLogin(cognito);
    await signIn(user);
    await typeCode(user, '000000');
    await user.click(await screen.findByRole('button', { name: 'Verificar y entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El código no es válido o venció. Pide uno nuevo.',
    );
  });

  it('goes back to sign-in when the MFA session expired', async () => {
    const cognito = fakeCognito({
      signIn: vi.fn(() => Promise.resolve<SignInStep>({ kind: 'mfa', challenge })),
      respondMfa: vi.fn(() => Promise.reject(new CognitoError('NotAuthorizedException'))),
    });
    const { user } = renderLogin(cognito);
    await signIn(user);
    await typeCode(user);
    await user.click(await screen.findByRole('button', { name: 'Verificar y entrar' }));
    expect(await screen.findByRole('heading', { name: 'Bienvenido' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo completar el inicio de sesión');
  });

  it('enrolls TOTP with a local QR and a copyable secret', async () => {
    const cognito = fakeCognito({
      signIn: vi.fn(() => Promise.resolve<SignInStep>({ kind: 'mfaSetup', challenge })),
    });
    const { auth, user } = renderLogin(cognito);
    // user-event installs its own clipboard; observe it.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    await signIn(user);
    expect(
      await screen.findByRole('heading', { name: 'Configura la verificación en dos pasos' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    // The placeholder and the QR are different elements with the same role and name: query on
    // every attempt, a node kept from before the swap never becomes the <svg>.
    await waitFor(() => {
      expect(screen.getByRole('img', { name: QR_NAME }).tagName.toLowerCase()).toBe('svg');
    });
    await user.click(screen.getByRole('button', { name: 'Copiar secreto' }));
    expect(writeText).toHaveBeenCalledWith(SECRET);
    await typeCode(user);
    await user.click(screen.getByRole('button', { name: 'Activar y entrar' }));
    expect(cognito.beginMfaSetup).toHaveBeenCalledOnce();
    expect(cognito.completeMfaSetup).toHaveBeenCalledWith(
      { ...challenge, session: 's2' },
      '123456',
    );
    expect(auth.acceptTokens).toHaveBeenCalledWith(tokens);
  });

  it('swaps the placeholder for the QR when it is drawn after the secret', async () => {
    let draw!: () => void;
    const drawn = new Promise<void>((resolve) => {
      draw = resolve;
    });
    const { qrMatrix: realQrMatrix } = await vi.importActual<typeof totp>('./login/totp');
    vi.mocked(totp.qrMatrix).mockImplementation(async (text) => {
      await drawn;
      return realQrMatrix(text);
    });
    const cognito = fakeCognito({
      signIn: vi.fn(() => Promise.resolve<SignInStep>({ kind: 'mfaSetup', challenge })),
    });
    const { user } = renderLogin(cognito);
    await signIn(user);
    expect(await screen.findByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    const placeholder = screen.getByRole('img', { name: QR_NAME });
    expect(placeholder.tagName.toLowerCase()).toBe('div');
    expect(placeholder).toHaveAttribute('aria-busy', 'true');
    draw();
    await waitFor(() => {
      expect(screen.getByRole('img', { name: QR_NAME }).tagName.toLowerCase()).toBe('svg');
    });
    expect(placeholder).not.toBeInTheDocument();
  });

  it('offers SSO only when the installation has an IdP', async () => {
    const startSso = vi.fn(() => new Promise<void>(() => undefined));
    const { user } = renderLogin(fakeCognito(), { ssoAvailable: true, startSso });
    await user.click(screen.getByRole('button', { name: 'Continuar con SSO' }));
    expect(startSso).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Redirigiendo a tu proveedor…' })).toBeDisabled();
  });

  it('says how long the session lasts under «Entrar»', () => {
    renderLogin();
    expect(
      screen.getByText(
        'Sigues dentro hasta 12 h, aunque recargues o cierres el navegador. En un equipo compartido, cierra sesión al terminar.',
      ),
    ).toBeInTheDocument();
  });

  it('says the session was closed in another tab', () => {
    renderLogin(fakeCognito(), { noticeKey: 'auth.signedOutElsewhere' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Cerraste sesión en otra pestaña. Vuelve a entrar para seguir.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the session error it was opened with', () => {
    renderLogin(fakeCognito(), { errorKey: 'auth.errors.sessionExpired' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Tu sesión expiró. Vuelve a iniciar sesión.',
    );
  });
});

/**
 * Answers of Cognito to a call that sends an email (`ForgotPassword`, `ResendConfirmationCode`)
 * with `PreventUserExistenceErrors` on. `null` is the answer of a code that was sent, which is
 * also what a missing account gets.
 */
const SENT_OR_ACCOUNT_DEPENDENT = [
  null,
  'UserNotFoundException',
  'UserNotConfirmedException',
  'NotAuthorizedException',
  'InvalidParameterException',
  'CodeDeliveryFailureException',
  'InvalidEmailRoleAccessPolicyException',
  'UserLambdaValidationException',
  'UnexpectedLambdaException',
  'InvalidLambdaResponseException',
  // Per-user attempt limit or daily email quota: not shown, it could tell accounts apart.
  'LimitExceededException',
  // Not classified: treated as sent.
  'ResourceNotFoundException',
  'InvalidResponse',
  'Http400',
];
/** Decided without looking at the account: WAF block, request rate, network, service. */
const SEND_REJECTIONS = [
  'ForbiddenException',
  'Http403',
  'TooManyRequestsException',
  'Http429',
  'NetworkError',
  'InternalErrorException',
  'Http503',
];
const ACTION_FAILED = 'No se pudo completar la acción. Inténtalo de nuevo.';
const EXISTING = 'nombre@empresa.com';
const MISSING = 'nadie@empresa.com';

function answering(code: string | null) {
  return vi.fn(() => (code ? Promise.reject(new CognitoError(code)) : Promise.resolve()));
}

describe('LoginPage: sign-up', () => {
  async function fillSignUp(
    user: ReturnType<typeof userEvent.setup>,
    email: string,
    password = PASSWORD,
  ) {
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    await user.type(screen.getByPlaceholderText('Nombre · Usuario 1'), 'Usuario 1');
    await user.type(screen.getByLabelText('Correo de la empresa'), email);
    await user.type(screen.getByLabelText('Contraseña'), password);
    // The AI use policy checkbox only exists when the installation sets `aiPolicyUrl`.
    const terms = screen.queryByRole('checkbox');
    if (terms) await user.click(terms);
    // The footer link is gone on the sign-up step: the only "Crear cuenta" is the submit.
    await user.click(
      within(screen.getByRole('main')).getByRole('button', { name: 'Crear cuenta' }),
    );
  }

  it('hints the company domain before calling Cognito', async () => {
    const { cognito, user } = renderLogin();
    await fillSignUp(user, 'x@evilempresa.com');
    expect(
      screen.getByText('Solo se aceptan correos @empresa.com. Usa tu correo de la empresa.'),
    ).toBeInTheDocument();
    expect(cognito.signUp).not.toHaveBeenCalled();
  });

  it('checks the Cognito password policy', async () => {
    const { cognito, user } = renderLogin();
    await fillSignUp(user, 'u@empresa.com', 'Short1!');
    expect(
      screen.getByText('Mínimo 14 caracteres, con mayúsculas, minúsculas, números y símbolos'),
    ).toHaveClass('login-err');
    expect(cognito.signUp).not.toHaveBeenCalled();
  });

  it('always shows the password rule and a 5-criteria meter', async () => {
    const { user } = renderLogin();
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    const rule = screen.getByText(
      'Mínimo 14 caracteres, con mayúsculas, minúsculas, números y símbolos',
    );
    expect(rule).toHaveClass('login-hint');
    const input = screen.getByLabelText('Contraseña');
    expect(input).toHaveAttribute('aria-describedby', rule.id);
    await user.type(input, 'abcdefghijklmn');
    expect(screen.getByText('Aún no cumple')).toBeInTheDocument();
    const meter = screen.getByText('Aún no cumple').closest('.login-meter');
    expect(meter?.querySelectorAll('.login-meter-bars > span')).toHaveLength(5);
    expect(meter?.querySelectorAll('.login-meter-weak')).toHaveLength(2);
    await user.clear(input);
    await user.type(input, PASSWORD);
    expect(screen.getByText('Cumple la política')).toBeInTheDocument();
  });

  it('asks to accept the AI use policy only when the installation links one', async () => {
    const withPolicy = { ...config, aiPolicyUrl: 'https://intranet.empresa.com/ia' };
    const { cognito, user } = renderLogin(fakeCognito(), {}, withPolicy);
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    const link = screen.getByRole('link', { name: 'política de uso de IA' });
    expect(link).toHaveAttribute('href', 'https://intranet.empresa.com/ia');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await user.type(screen.getByPlaceholderText('Nombre · Usuario 1'), 'Usuario 1');
    await user.type(screen.getByLabelText('Correo de la empresa'), 'u@empresa.com');
    await user.type(screen.getByLabelText('Contraseña'), PASSWORD);
    await user.click(
      within(screen.getByRole('main')).getByRole('button', { name: 'Crear cuenta' }),
    );
    expect(screen.getByText('Acepta la política de uso de IA')).toBeInTheDocument();
    expect(cognito.signUp).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(
      within(screen.getByRole('main')).getByRole('button', { name: 'Crear cuenta' }),
    );
    expect(cognito.signUp).toHaveBeenCalled();
  });

  it.each(['javascript:alert(1)', 'http://intranet.empresa.com/ia', 'data:text/html,x'])(
    'never renders a non-https policy link (%s), even if it bypassed config validation',
    async (url) => {
      const { user } = renderLogin(fakeCognito(), {}, { ...config, aiPolicyUrl: url });
      await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.queryByRole('link', { name: 'política de uso de IA' })).toBeNull();
    },
  );

  it.each([null, 'UsernameExistsException'])(
    'answers the same whether the account is new or exists (%s), then verifies and signs in',
    async (error) => {
      const cognito = fakeCognito({
        signUp: vi.fn(() => (error ? Promise.reject(new CognitoError(error)) : Promise.resolve())),
      });
      const { auth, user } = renderLogin(cognito);
      await fillSignUp(user, 'U@empresa.com');
      expect(cognito.signUp).toHaveBeenCalledWith('u@empresa.com', PASSWORD, 'Usuario 1');
      expect(
        await screen.findByRole('heading', { name: 'Verifica tu correo' }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/te enviamos un código de 6 dígitos. Vence en 24 horas/),
      ).toBeInTheDocument();
      await typeCode(user);
      await user.click(screen.getByRole('button', { name: 'Verificar correo' }));
      expect(cognito.confirmSignUp).toHaveBeenCalledWith('u@empresa.com', '123456');
      expect(cognito.signIn).toHaveBeenCalledWith('u@empresa.com', PASSWORD);
      expect(auth.acceptTokens).toHaveBeenCalledWith(tokens);
    },
  );

  it('shows the domain error when the pre sign-up trigger rejects', async () => {
    const cognito = fakeCognito({
      signUp: vi.fn(() => Promise.reject(new CognitoError('UserLambdaValidationException'))),
    });
    const { user } = renderLogin(cognito);
    await fillSignUp(user, 'u@empresa.com');
    expect(
      await screen.findByText('Solo se aceptan correos @empresa.com. Usa tu correo de la empresa.'),
    ).toBeInTheDocument();
  });

  it.each([
    'ForbiddenException',
    'TooManyRequestsException',
    'LimitExceededException',
    'NetworkError',
    'InternalErrorException',
  ])('shows the generic error, not a sign-in one, when sign-up is rejected (%s)', async (code) => {
    const cognito = fakeCognito({
      signUp: vi.fn(() => Promise.reject(new CognitoError(code))),
    });
    const { user } = renderLogin(cognito);
    await fillSignUp(user, 'nombre@empresa.com');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No se pudo completar la acción. Inténtalo de nuevo.',
    );
    expect(screen.queryByText(/inicio de sesión/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Crea tu cuenta' })).toBeInTheDocument();
    expect(screen.queryByText(/te enviamos un código/)).toBeNull();
  });

  it.each(SEND_REJECTIONS)(
    'does not say it resent a verification code that was rejected (%s)',
    async (code) => {
      const cognito = fakeCognito({ resendCode: answering(code) });
      const { user } = renderLogin(cognito);
      await fillSignUp(user, 'nombre@empresa.com');
      await user.click(await screen.findByRole('button', { name: 'Reenviar código' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(ACTION_FAILED);
      expect(screen.queryByRole('status')).toBeNull();
    },
  );

  it.each(SENT_OR_ACCOUNT_DEPENDENT)(
    'resends the verification code with a neutral message (%s)',
    async (code) => {
      const cognito = fakeCognito({ resendCode: answering(code) });
      const { user } = renderLogin(cognito);
      await fillSignUp(user, 'nombre@empresa.com');
      await user.click(await screen.findByRole('button', { name: 'Reenviar código' }));
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Si corresponde, te enviamos un código nuevo.',
      );
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it('renders the email as text, never as markup', async () => {
    const cognito = fakeCognito({
      signIn: vi.fn(() => Promise.reject(new CognitoError('UserNotConfirmedException'))),
    });
    const { user } = renderLogin(cognito);
    await signIn(user, '<b>x</b>@empresa.com');
    const subtitle = (await screen.findByText(/puede registrarse/)).closest('p');
    if (!subtitle) throw new Error('no subtitle');
    expect(subtitle.querySelectorAll('b')).toHaveLength(1);
    expect(subtitle.textContent).toContain('<b>x</b>@empresa.com');
  });
});

describe('LoginPage: temporary password (NEW_PASSWORD_REQUIRED)', () => {
  it('asks for a new password twice and continues', async () => {
    const cognito = fakeCognito({
      signIn: vi.fn(() => Promise.resolve<SignInStep>({ kind: 'newPassword', challenge })),
    });
    const { auth, user } = renderLogin(cognito);
    await signIn(user, 'nuevo@empresa.com');
    expect(await screen.findByRole('heading', { name: 'Crea tu contraseña' })).toBeInTheDocument();
    expect(screen.getByText(/con una contraseña temporal/).closest('p')).toHaveTextContent(
      'Un admin creó tu cuenta nuevo@empresa.com con una contraseña temporal.',
    );
    expect(
      screen.getByText('Mínimo 14 caracteres, con mayúsculas, minúsculas, números y símbolos'),
    ).toHaveClass('login-hint');
    await user.type(screen.getByLabelText('Nueva contraseña'), PASSWORD);
    await user.type(screen.getByLabelText('Confirma la contraseña'), `${PASSWORD}x`);
    await user.click(screen.getByRole('button', { name: 'Guardar y continuar' }));
    expect(screen.getByText('Las contraseñas no coinciden')).toBeInTheDocument();
    expect(cognito.respondNewPassword).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('Confirma la contraseña'));
    await user.type(screen.getByLabelText('Confirma la contraseña'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Guardar y continuar' }));
    expect(cognito.respondNewPassword).toHaveBeenCalledWith(challenge, PASSWORD);
    await waitFor(() => {
      expect(auth.acceptTokens).toHaveBeenCalledWith(tokens);
    });
  });

  it('refuses a password outside the policy and offers another account', async () => {
    const cognito = fakeCognito({
      signIn: vi.fn(() => Promise.resolve<SignInStep>({ kind: 'newPassword', challenge })),
    });
    const { user } = renderLogin(cognito);
    await signIn(user);
    await user.type(await screen.findByLabelText('Nueva contraseña'), 'short');
    await user.click(screen.getByRole('button', { name: 'Guardar y continuar' }));
    expect(
      screen.getByText('Mínimo 14 caracteres, con mayúsculas, minúsculas, números y símbolos'),
    ).toHaveClass('login-err');
    expect(cognito.respondNewPassword).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Usar otra cuenta' }));
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeInTheDocument();
  });
});

/** Runs `flow` once per email and returns what each one sees, without the email itself. */
async function screensFor(flow: (email: string) => Promise<void>): Promise<string[]> {
  const screens: string[] = [];
  for (const email of [EXISTING, MISSING]) {
    await flow(email);
    screens.push(screen.getByRole('main').textContent.replaceAll(email, '<email>'));
    cleanup();
  }
  return screens;
}

async function requestCode(user: ReturnType<typeof userEvent.setup>, email: string) {
  await user.click(screen.getByRole('button', { name: '¿Olvidaste tu contraseña?' }));
  await user.type(screen.getByLabelText('Correo'), email);
  await user.click(screen.getByRole('button', { name: 'Enviar código' }));
}

describe('LoginPage: password recovery', () => {
  it('continues to the code step and then back to sign-in', async () => {
    const { cognito, user } = renderLogin();
    await requestCode(user, MISSING);
    expect(
      await screen.findByRole('heading', { name: 'Crea una contraseña nueva' }),
    ).toBeInTheDocument();
    await typeCode(user);
    await user.type(screen.getByLabelText('Nueva contraseña'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Guardar contraseña' }));
    expect(cognito.confirmForgotPassword).toHaveBeenCalledWith(MISSING, '123456', PASSWORD);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Contraseña actualizada. Ya puedes entrar.',
    );
  });

  it.each(SENT_OR_ACCOUNT_DEPENDENT)(
    'continues to the code step, the same for an existing and a missing account (%s)',
    async (code) => {
      const [existing, missing] = await screensFor(async (email) => {
        const { user } = renderLogin(fakeCognito({ forgotPassword: answering(code) }));
        await requestCode(user, email);
        expect(
          await screen.findByRole('heading', { name: 'Crea una contraseña nueva' }),
        ).toBeInTheDocument();
        expect(screen.getByText(/tiene una cuenta, te enviamos un código/)).toBeInTheDocument();
      });
      expect(existing).toBe(missing);
      expect(existing).not.toContain(ACTION_FAILED);
    },
  );

  it.each(SEND_REJECTIONS)(
    'stays on the form with the generic error, the same for an existing and a missing account (%s)',
    async (code) => {
      const [existing, missing] = await screensFor(async (email) => {
        const { user } = renderLogin(fakeCognito({ forgotPassword: answering(code) }));
        await requestCode(user, email);
        expect(await screen.findByText(ACTION_FAILED)).toHaveClass('login-err');
        expect(screen.getByRole('heading', { name: 'Recupera tu contraseña' })).toBeInTheDocument();
        expect(screen.queryByText(/te enviamos un código/)).toBeNull();
        expect(screen.getByRole('button', { name: 'Enviar código' })).toBeEnabled();
      });
      expect(existing).toBe(missing);
    },
  );

  it('clears the error when the email changes and continues once the code is sent', async () => {
    const forgotPassword = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new CognitoError('ForbiddenException'))
      .mockResolvedValue();
    const { user } = renderLogin(fakeCognito({ forgotPassword }));
    await requestCode(user, EXISTING);
    expect(await screen.findByText(ACTION_FAILED)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Correo'), '{backspace}m');
    expect(screen.queryByText(ACTION_FAILED)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Enviar código' }));
    expect(
      await screen.findByRole('heading', { name: 'Crea una contraseña nueva' }),
    ).toBeInTheDocument();
  });

  it.each(SENT_OR_ACCOUNT_DEPENDENT)(
    'resends with a neutral message, the same for an existing and a missing account (%s)',
    async (code) => {
      const [existing, missing] = await screensFor(async (email) => {
        const forgotPassword = vi
          .fn<() => Promise<void>>()
          .mockResolvedValueOnce()
          .mockImplementation(answering(code));
        const { user } = renderLogin(fakeCognito({ forgotPassword }));
        await requestCode(user, email);
        await user.click(await screen.findByRole('button', { name: 'Reenviar código' }));
        expect(forgotPassword).toHaveBeenCalledTimes(2);
        expect(await screen.findByRole('status')).toHaveTextContent(
          'Si corresponde, te enviamos un código nuevo.',
        );
        expect(screen.queryByRole('alert')).toBeNull();
      });
      expect(existing).toBe(missing);
    },
  );

  it.each(SEND_REJECTIONS)(
    'does not say it resent a code that was rejected, the same for both accounts (%s)',
    async (code) => {
      const [existing, missing] = await screensFor(async (email) => {
        const forgotPassword = vi
          .fn<() => Promise<void>>()
          .mockResolvedValueOnce()
          .mockImplementation(answering(code));
        const { user } = renderLogin(fakeCognito({ forgotPassword }));
        await requestCode(user, email);
        await user.click(await screen.findByRole('button', { name: 'Reenviar código' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(ACTION_FAILED);
        expect(screen.queryByText('Si corresponde, te enviamos un código nuevo.')).toBeNull();
        expect(
          screen.getByRole('heading', { name: 'Crea una contraseña nueva' }),
        ).toBeInTheDocument();
      });
      expect(existing).toBe(missing);
    },
  );
});

function mockReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: reduce && query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

/** Id of the dot (tab) that labels slide `n`; the visible tabpanel points at it. */
function dotId(n: number) {
  return screen.getByRole('tab', { name: `Diapositiva ${String(n)}` }).id;
}

function visibleSlide() {
  return screen.getByRole('tabpanel').getAttribute('aria-labelledby');
}

describe('LoginCarousel', () => {
  it('is an accessible carousel that autoplays every 5 s', async () => {
    mockReducedMotion(false);
    vi.useFakeTimers();
    renderLogin();
    const region = screen.getByRole('region', { name: 'Qué puedes hacer con Mango' });
    expect(region).toHaveAttribute('aria-roledescription', 'carrusel');
    expect(visibleSlide()).toBe(dotId(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLIDE_INTERVAL_MS);
    });
    expect(visibleSlide()).toBe(dotId(2)); // Design v14 slides: each exposes its title as text; the illustration is decorative.
    const slide = screen.getByRole('tabpanel', { name: 'Diapositiva 2' });
    expect(slide).toHaveTextContent('Pregúntale a FinOps por tus costos');
    expect(slide).toHaveTextContent('¿Qué servicio subió más este mes?');
    expect(screen.queryByText(/FinOps Navigator/)).toBeNull();
    const art = slide.querySelector('.login-art');
    expect(art).toHaveAttribute('aria-hidden', 'true');
    // Design: the sr-only title comes first, then the hidden illustration.
    expect(art?.previousElementSibling).toHaveClass('sr-only');
    expect(art?.previousElementSibling).toHaveTextContent('Pregúntale a FinOps por tus costos');
  });

  it('stops autoplay with the pause control', async () => {
    mockReducedMotion(false);
    vi.useFakeTimers();
    renderLogin();
    // Design login.jsx: a text button after the dots; its label carries the state (no aria-pressed).
    const pause = screen.getByRole('button', { name: 'Pausar' });
    expect(pause).not.toHaveAttribute('aria-pressed');
    expect(pause.previousElementSibling).toHaveClass('login-dots');
    act(() => {
      pause.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLIDE_INTERVAL_MS * 2);
    });
    expect(visibleSlide()).toBe(dotId(1));
    const resume = screen.getByRole('button', { name: 'Reanudar' });
    expect(resume).not.toHaveAttribute('aria-pressed');

    act(() => {
      resume.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLIDE_INTERVAL_MS);
    });
    expect(visibleSlide()).toBe(dotId(2));
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeInTheDocument();
  });

  it('has no pause button and no autoplay with reduced motion', async () => {
    mockReducedMotion(true);
    vi.useFakeTimers();
    renderLogin();
    expect(screen.queryByRole('button', { name: 'Pausar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reanudar' })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLIDE_INTERVAL_MS * 2);
    });
    expect(visibleSlide()).toBe(dotId(1));
    // The dots still work.
    act(() => {
      screen.getByRole('tab', { name: 'Diapositiva 3' }).click();
    });
    expect(visibleSlide()).toBe(dotId(3));
  });

  it('exposes the dots as tabs that control the slides, with arrow keys', () => {
    mockReducedMotion(true);
    renderLogin();
    // Design login.jsx: role="tablist" "Diapositivas" with one "Diapositiva N" tab per slide.
    const tablist = screen.getByRole('tablist', { name: 'Diapositivas' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'Diapositiva 1',
      'Diapositiva 2',
      'Diapositiva 3',
    ]);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.queryByRole('button', { name: /diapositiva/i })).toBeNull();
    // Every tab controls its slide, and the visible slide is named by the selected tab.
    const panels = screen.getAllByRole('tabpanel', { hidden: true });
    expect(tabs.map((tab) => tab.getAttribute('aria-controls'))).toEqual(panels.map((p) => p.id));
    expect(screen.getByRole('tabpanel', { name: 'Diapositiva 1' })).toBeVisible();

    const [first, second, third] = tabs as [HTMLElement, HTMLElement, HTMLElement];
    act(() => {
      first.focus();
    });
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveAttribute('aria-selected', 'false');
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    expect(visibleSlide()).toBe(second.id);

    fireEvent.keyDown(second, { key: 'End' });
    expect(third).toHaveFocus();
    fireEvent.keyDown(third, { key: 'ArrowRight' }); // wraps around
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(third).toHaveFocus();
    fireEvent.keyDown(third, { key: 'Home' });
    expect(first).toHaveFocus();
    expect(visibleSlide()).toBe(first.id);
  });

  it('pauses while hovered', async () => {
    mockReducedMotion(false);
    vi.useFakeTimers();
    renderLogin();
    fireEvent.mouseEnter(screen.getByRole('region', { name: 'Qué puedes hacer con Mango' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLIDE_INTERVAL_MS * 2);
    });
    expect(visibleSlide()).toBe(dotId(1));
  });

  it('announces slide changes only while the rotation is stopped', () => {
    mockReducedMotion(false);
    renderLogin();
    const region = screen.getByRole('region', { name: 'Qué puedes hacer con Mango' });
    const stage = region.querySelector('.login-stage');
    // Design login.jsx: aria-live is "off" while autoplaying and "polite" when paused by the
    // button, hover or focus inside the panel.
    expect(stage).toHaveAttribute('aria-live', 'off');
    fireEvent.mouseEnter(region);
    expect(stage).toHaveAttribute('aria-live', 'polite');
    fireEvent.mouseLeave(region);
    expect(stage).toHaveAttribute('aria-live', 'off');
    act(() => {
      screen.getByRole('tab', { name: 'Diapositiva 1' }).focus();
    });
    expect(stage).toHaveAttribute('aria-live', 'polite');
    act(() => {
      screen.getByRole('tab', { name: 'Diapositiva 1' }).blur();
    });
    expect(stage).toHaveAttribute('aria-live', 'off');
    act(() => {
      screen.getByRole('button', { name: 'Pausar' }).click();
    });
    expect(stage).toHaveAttribute('aria-live', 'polite');
  });
});
