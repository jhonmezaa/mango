import type { ReactNode } from 'react';
import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { noteNewToken, resetConsentHold, tokenHeld } from '../../auth/consentHold';
import { ChatMarkdown } from '../../components/ChatMarkdown';
import { authValue, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { ConnectCard } from './ConnectCard';
import { ConnectionsContext, useConnections, type ConnectionsValue } from './ConnectionsContext';
import { ConnectionsProvider } from './ConnectionsProvider';
import { CONSENT_CHANNEL, type ConsentMessage } from './consentChannel';
import { ConnectReturnPage } from './ConnectReturnPage';
import { captureConsentReturn, resetConsentReturn } from './consentReturn';
import { resetReturnRelay } from './returnRelay';
import type { Connection } from './model';
import { consentNavigation } from './navigation';
import { connection } from './testFixtures';
import { useStripSources } from './useStripSources';

const REG = 'abcdefghij23';
const CONSENT =
  'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/authorize?request_uri=x';
const SESSION = 'urn:ietf:params:oauth:request_uri:abc123';

type Answers = Record<string, (input: unknown) => Promise<unknown>>;

function apiWith(list: Connection[], answers: Answers = {}, enabled = true) {
  return vi.fn((operation: string, input: unknown) => {
    if (operation === 'listMyConnections')
      return Promise.resolve({ enabled, connections: [...list] });
    const answer = answers[operation];
    return answer ? answer(input) : Promise.reject(new Error(`unexpected ${operation}`));
  });
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function OpenMine() {
  const { openMine } = useConnections();
  return (
    <button type="button" onClick={openMine}>
      open mine
    </button>
  );
}

function renderWith(
  children: ReactNode,
  call: ReturnType<typeof vi.fn>,
  path = '/',
  refreshSession = vi.fn(() => Promise.resolve(true)),
) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders session={sessionValue({ api })} auth={authValue({ refreshSession })} path={path}>
      <ConnectionsProvider>
        <Routes>
          <Route path="conexiones/vuelta" element={children} />
          <Route path="*" element={children} />
        </Routes>
        <Where />
      </ConnectionsProvider>
    </TestProviders>,
  );
}

/** The tab «Conectar» opens for the provider (D100), as a double. */
function fakeTab() {
  const tab = { go: vi.fn(), close: vi.fn() };
  const open = vi.spyOn(consentNavigation, 'open').mockReturnValue(tab);
  return { tab, open };
}

/** The other end of the channel: what a return page (or another tab) sends and hears. */
function otherPage() {
  const channel = new BroadcastChannel(CONSENT_CHANNEL);
  const heard: ConsentMessage[] = [];
  channel.onmessage = (event: MessageEvent<ConsentMessage>) => {
    heard.push(event.data);
  };
  return {
    heard,
    send(message: ConsentMessage) {
      channel.postMessage(message);
    },
    close() {
      channel.close();
    },
  };
}

const REF = '0b8f3c1e-5d2a-4c9e-8f1a-2b3c4d5e6f70';
const consentRequired = () =>
  Promise.resolve({ status: 'consent_required', authorization_url: CONSENT, expires_at: null });

afterEach(() => {
  vi.restoreAllMocks();
  resetConsentReturn();
  resetReturnRelay();
  resetConsentHold();
});

describe('Mis conexiones', () => {
  it('lists the registrations with the design states', async () => {
    const call = apiWith([
      connection(),
      connection({
        registration_id: 'klmnopqrst45',
        organization: 'labs',
        status: 'connected',
        connected_at: new Date().toISOString(),
      }),
      connection({ registration_id: 'uvwxyzabcd67', organization: 'off', status: 'disabled' }),
      connection({
        registration_id: 'efghijklmn23',
        organization: 'exp',
        status: 'secret_expired',
      }),
      connection({
        registration_id: 'opqrstuvwx45',
        organization: 'exp-on',
        status: 'secret_expired',
        connected_at: new Date().toISOString(),
      }),
    ]);
    renderWith(<OpenMine />, call);
    await userEvent.click(screen.getByRole('button', { name: 'open mine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mis conexiones' });
    expect(await within(dialog).findByText('No has conectado tu cuenta.')).toBeInTheDocument();
    expect(within(dialog).getByText(/^Conectado/)).toBeInTheDocument();
    expect(
      within(dialog).getByText('Un administrador deshabilitó Azure DevOps.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/^Por ahora no se puede conectar/)).toBeInTheDocument();
    expect(within(dialog).getByText(/^Tu cuenta sigue conectada, pero/)).toBeInTheDocument();
    // Only the row that is not connected can connect. «Desconectar» (D97) on the connected row
    // and on the connected one with the app's secret expired (design round 24).
    expect(within(dialog).getAllByRole('button', { name: 'Conectar' })).toHaveLength(1);
    expect(within(dialog).getAllByRole('button', { name: 'Desconectar' })).toHaveLength(2);
    expect(within(dialog).getByText(/vas a iniciar sesión en Microsoft/)).toBeInTheDocument();
  });

  it('says an account was already connected without leaving (A6)', async () => {
    const { tab } = fakeTab();
    const list = [connection()];
    const call = apiWith(list, {
      connectMyAccount: () => {
        // The API writes the connection: the next read says so.
        list[0] = connection({ status: 'connected' });
        return Promise.resolve({ status: 'already_connected' });
      },
    });
    renderWith(<OpenMine />, call);
    await userEvent.click(screen.getByRole('button', { name: 'open mine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mis conexiones' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Conectar' }));
    expect(await within(dialog).findByText('Tu cuenta ya estaba conectada.')).toBeInTheDocument();
    expect(tab.go).not.toHaveBeenCalled();
    expect(tab.close).toHaveBeenCalled();
    expect(tokenHeld()).toBe(false);
    expect(call).toHaveBeenCalledWith('connectMyAccount', { path: { reg: REG }, body: {} });
  });

  it('renews the session, opens the provider in another tab and waits (D100)', async () => {
    const { tab } = fakeTab();
    const order: string[] = [];
    const refreshSession = vi.fn(() => {
      order.push('refresh');
      return Promise.resolve(true);
    });
    const call = apiWith([connection()], {
      connectMyAccount: () => {
        order.push('connect');
        return consentRequired();
      },
    });
    renderWith(<OpenMine />, call, '/', refreshSession);
    await userEvent.click(screen.getByRole('button', { name: 'open mine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mis conexiones' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Conectar' }));
    await waitFor(() => {
      expect(tab.go).toHaveBeenCalledWith(CONSENT);
    });
    // The token the consent is bound to is the renewed one, kept until the return (D100 (3)).
    expect(order).toEqual(['refresh', 'connect']);
    expect(tokenHeld()).toBe(true);
    expect(
      await within(dialog).findByText(
        'Inicia sesión en Microsoft en la otra pestaña. Al terminar, la conexión se completa aquí.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Abrir de nuevo/ })).toBeInTheDocument();
  });

  it('says the browser blocked the tab (design round 25)', async () => {
    vi.spyOn(consentNavigation, 'open').mockReturnValue(null);
    const call = apiWith([connection()], { connectMyAccount: consentRequired });
    renderWith(<OpenMine />, call);
    await userEvent.click(screen.getByRole('button', { name: 'open mine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mis conexiones' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Conectar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('El navegador bloqueó la pestaña de Microsoft');
    expect(alert).toHaveTextContent(
      'Permite las ventanas emergentes de Mango en este navegador y vuelve a pulsar «Conectar».',
    );
    expect(within(dialog).getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    expect(call).not.toHaveBeenCalledWith('connectMyAccount', expect.anything());
  });

  it('never opens a consent URL of another host', async () => {
    const { tab } = fakeTab();
    const call = apiWith([connection()], {
      connectMyAccount: () =>
        Promise.resolve({
          status: 'consent_required',
          authorization_url: 'https://login.example.net/phish',
          expires_at: null,
        }),
    });
    renderWith(<OpenMine />, call);
    await userEvent.click(screen.getByRole('button', { name: 'open mine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mis conexiones' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Conectar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'No se pudo iniciar la conexión. Inténtalo de nuevo en unos segundos.',
    );
    expect(within(dialog).getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    expect(tab.go).not.toHaveBeenCalled();
    expect(tab.close).toHaveBeenCalled();
    expect(tokenHeld()).toBe(false);
  });

  it('disconnects with the design dialog (D97) and says when it cannot confirm it', async () => {
    let fail = true;
    const disconnect = vi.fn(() =>
      fail
        ? Promise.reject(new ApiError(502, 'disconnect_not_confirmed', 'x'))
        : Promise.resolve({ ...connection(), status: 'not_connected' }),
    );
    const call = apiWith(
      [connection({ status: 'connected', connected_at: new Date().toISOString() })],
      { disconnectMyAccount: disconnect },
    );
    renderWith(<OpenMine />, call);
    await userEvent.click(screen.getByRole('button', { name: 'open mine' }));
    const list = await screen.findByRole('dialog', { name: 'Mis conexiones' });
    await userEvent.click(await within(list).findByRole('button', { name: 'Desconectar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Desconectar Azure DevOps' });
    expect(
      within(dialog).getByText('Mango no cambia nada en tu cuenta de Microsoft.'),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Desconectar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'No se pudo confirmar que se desconectó',
    );
    fail = false;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Desconectaste tu cuenta de Azure DevOps')).toBeInTheDocument();
    expect(disconnect).toHaveBeenCalledWith({
      path: { reg: connection().registration_id },
      body: {},
    });
  });

  it('shows the empty state of the design', async () => {
    renderWith(<OpenMine />, apiWith([]));
    await userEvent.click(screen.getByRole('button', { name: 'open mine' }));
    expect(
      await screen.findByText('Ningún servicio externo está habilitado para tus grupos.'),
    ).toBeInTheDocument();
  });

  it('shows no list when remote servers are off in the installation (design round 25)', async () => {
    renderWith(<OpenMine />, apiWith([connection()], {}, false));
    await userEvent.click(screen.getByRole('button', { name: 'open mine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mis conexiones' });
    expect(
      await within(dialog).findByText('Los servicios externos están apagados en esta instalación'),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      'Cuando un administrador los encienda, aquí vas a poder conectar tu cuenta.',
    );
    expect(within(dialog).queryByText('Azure DevOps')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Conectar' })).not.toBeInTheDocument();
  });
});

describe('ConnectCard', () => {
  it('asks to connect with the countdown, outside the answer', async () => {
    renderWith(
      <ConnectCard registrationId={REG} startedAt={Date.now()} />,
      apiWith([connection()]),
    );
    const card = await screen.findByRole('region', {
      name: 'Aviso de Mango: conectar Azure DevOps',
    });
    expect(within(card).getByText('No lo escribió el agente')).toBeInTheDocument();
    expect(within(card).getByText('Conecta tu cuenta de Azure DevOps')).toBeInTheDocument();
    expect(within(card).getByText(/^Vence en (10:00|9:5\d)$/)).toBeInTheDocument();
  });

  it('expires after ten minutes and offers Mis conexiones', async () => {
    renderWith(
      <ConnectCard registrationId={REG} startedAt={Date.now() - 11 * 60_000} />,
      apiWith([connection()]),
    );
    expect(await screen.findByText('El enlace venció')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Conectar/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mis conexiones' }));
    expect(await screen.findByRole('dialog', { name: 'Mis conexiones' })).toBeInTheDocument();
  });

  it('turns to «Conectado» when the account was already connected', async () => {
    const list = [connection()];
    const call = apiWith(list, {
      connectMyAccount: () => {
        list[0] = connection({ status: 'connected' });
        return Promise.resolve({ status: 'already_connected' });
      },
    });
    fakeTab();
    renderWith(<ConnectCard registrationId={REG} startedAt={Date.now()} />, call);
    await userEvent.click(await screen.findByRole('button', { name: /Conectar/ }));
    expect(await screen.findByText('Conectado')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Tu cuenta de Azure DevOps quedó conectada. Envía tu pregunta otra vez para que el agente lea Azure DevOps.',
      ),
    ).toBeInTheDocument();
    // Nothing to send again here: only the check.
    expect(screen.queryByRole('button', { name: 'Enviar de nuevo' })).not.toBeInTheDocument();
  });

  it('sends the question again once, from «Conectado» (design round 25)', async () => {
    const resend = vi.fn();
    renderWith(
      <ConnectCard registrationId={REG} startedAt={Date.now()} onResend={resend} />,
      apiWith([connection({ status: 'connected' })]),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Enviar de nuevo' }));
    expect(resend).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText('Tu cuenta de Azure DevOps quedó conectada. Enviaste tu pregunta otra vez.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar de nuevo' })).not.toBeInTheDocument();
  });

  it('does not offer it again when the conversation already asked later (design round 26)', async () => {
    renderWith(
      <ConnectCard registrationId={REG} startedAt={Date.now()} onResend={vi.fn()} asked />,
      apiWith([connection({ status: 'connected' })]),
    );
    expect(
      await screen.findByText(
        'Tu cuenta de Azure DevOps quedó conectada. Enviaste tu pregunta otra vez.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar de nuevo' })).not.toBeInTheDocument();
  });

  it('waits, disabled, while another turn answers (design round 26)', async () => {
    renderWith(
      <ConnectCard registrationId={REG} startedAt={Date.now()} onResend={vi.fn()} busy />,
      apiWith([connection({ status: 'connected' })]),
    );
    expect(await screen.findByRole('button', { name: 'Enviar de nuevo' })).toBeDisabled();
    expect(
      screen.getByText('Podrás enviarla cuando termine la respuesta en curso.'),
    ).toBeInTheDocument();
  });

  it('only says so when remote servers are off in the installation', async () => {
    renderWith(
      <ConnectCard registrationId={REG} startedAt={Date.now()} />,
      apiWith([connection()], {}, false),
    );
    const card = await screen.findByRole('region', {
      name: 'Aviso de Mango: conectar Azure DevOps',
    });
    expect(
      await within(card).findByText('Los servicios externos están apagados'),
    ).toBeInTheDocument();
    expect(card).toHaveTextContent(
      'Esta instalación de Mango tiene apagados los servicios externos, así que el agente no puede leer Azure DevOps. Si lo necesitas, avisa a un administrador de Mango.',
    );
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says the design text of a refused connect', async () => {
    const call = apiWith([connection()], {
      connectMyAccount: () => Promise.reject(new ApiError(409, 'remote_disabled', 'x')),
    });
    fakeTab();
    renderWith(<ConnectCard registrationId={REG} startedAt={Date.now()} />, call);
    await userEvent.click(await screen.findByRole('button', { name: /Conectar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Un administrador deshabilitó Azure DevOps.',
    );
  });

  it('shows nothing for a registration the person does not have', async () => {
    const call = apiWith([connection()]);
    renderWith(<ConnectCard registrationId="zzzzzzzzzzzz" startedAt={Date.now()} />, call);
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('listMyConnections');
    });
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});

describe('the tab that pressed «Conectar» closes the consent (D100)', () => {
  /** A card waiting for its return, with the API's callback answering `complete`. */
  async function waitingCard(complete: (input: unknown) => Promise<unknown>) {
    fakeTab();
    const list = [connection()];
    const call = apiWith(list, {
      connectMyAccount: consentRequired,
      completeConsent: (input) =>
        complete(input).then((done) => {
          list[0] = connection({ status: 'connected', connected_at: new Date().toISOString() });
          return done;
        }),
    });
    renderWith(<ConnectCard registrationId={REG} startedAt={Date.now()} />, call);
    await userEvent.click(await screen.findByRole('button', { name: /Conectar/ }));
    expect(
      await screen.findByText('Inicia sesión en Microsoft en la otra pestaña'),
    ).toBeInTheDocument();
    return call;
  }

  const connected = () =>
    Promise.resolve({ status: 'connected', registration_id: REG, profile_id: 'azure-devops' });

  it('closes it with its own token and tells the return page the service', async () => {
    const call = await waitingCard(connected);
    const page = otherPage();
    page.send({ kind: 'return', ref: REF, session_id: SESSION });
    expect(await screen.findByText('Conectado')).toBeInTheDocument();
    expect(call).toHaveBeenCalledWith('completeConsent', { body: { session_id: SESSION } });
    await waitFor(() => {
      expect(page.heard).toEqual([
        { kind: 'claimed', ref: REF },
        { kind: 'result', ref: REF, result: 'ok', service: 'Azure DevOps', idp: 'Microsoft' },
      ]);
    });
    expect(tokenHeld()).toBe(false);
    page.close();
  });

  it('does not try with another token: «Pídelo de nuevo» (D100 (3))', async () => {
    const call = await waitingCard(connected);
    act(() => {
      noteNewToken();
    });
    const page = otherPage();
    page.send({ kind: 'return', ref: REF, session_id: SESSION });
    expect(await screen.findByText('No se pudo terminar la conexión')).toBeInTheDocument();
    expect(
      screen.getByText(/Tu sesión de Mango cambió mientras iniciabas sesión/),
    ).toBeInTheDocument();
    expect(call).not.toHaveBeenCalledWith('completeConsent', expect.anything());
    await waitFor(() => {
      expect(page.heard).toContainEqual({ kind: 'result', ref: REF, result: 'orphan' });
    });
    page.close();
  });

  it('stays silent and waiting when Identity says it is not its consent', async () => {
    await waitingCard(() => Promise.reject(new ApiError(403, 'consent_not_yours', 'x')));
    const page = otherPage();
    page.send({ kind: 'return', ref: REF, session_id: SESSION });
    await waitFor(() => {
      expect(page.heard).toContainEqual({ kind: 'result', ref: REF, result: 'notyours' });
    });
    expect(screen.getByText('Inicia sesión en Microsoft en la otra pestaña')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    page.close();
  });

  it('shows the provider refusing it in the card', async () => {
    const call = await waitingCard(connected);
    const page = otherPage();
    page.send({ kind: 'provider', result: 'denied' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Microsoft no autorizó la conexión');
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    expect(call).not.toHaveBeenCalledWith('completeConsent', expect.anything());
    page.close();
  });

  it('ignores the return in a tab that is not waiting, and anything malformed', async () => {
    const call = apiWith([connection()], { completeConsent: connected });
    renderWith(<ConnectCard registrationId={REG} startedAt={Date.now()} />, call);
    await screen.findByText('Conecta tu cuenta de Azure DevOps');
    const page = otherPage();
    page.send({ kind: 'return', ref: REF, session_id: SESSION });
    page.send({ kind: 'return', ref: REF, session_id: 'https://evil.example/x' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.heard).toEqual([]);
    expect(call).not.toHaveBeenCalledWith('completeConsent', expect.anything());
    page.close();
  });
});

describe('the return page (D100)', () => {
  function capture(search: string) {
    captureConsentReturn(
      { pathname: '/conexiones/vuelta', search, hash: '' },
      { replaceState: () => undefined, state: null },
    );
  }

  /** A waiting tab that answers with `answer` (or never, with `null`). */
  function waitingTab(answer: string | null) {
    const channel = new BroadcastChannel(CONSENT_CHANNEL);
    const heard: ConsentMessage[] = [];
    channel.onmessage = (event: MessageEvent<ConsentMessage>) => {
      heard.push(event.data);
      const message = event.data;
      if (message.kind !== 'return' || answer === null) return;
      channel.postMessage({ kind: 'claimed', ref: message.ref });
      channel.postMessage(
        answer === 'ok'
          ? {
              kind: 'result',
              ref: message.ref,
              result: 'ok',
              service: 'Azure DevOps',
              idp: 'Microsoft',
            }
          : { kind: 'result', ref: message.ref, result: answer },
      );
    };
    return {
      heard,
      close: () => {
        channel.close();
      },
    };
  }

  it('hands only the session id to the tab, says «Listo» and closes itself', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    capture(`?session_id=${SESSION}`);
    const tab = waitingTab('ok');
    const call = apiWith([]);
    renderWith(<ConnectReturnPage />, call, '/conexiones/vuelta');
    expect(screen.getByRole('heading', { name: 'Terminando la conexión…' })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Listo, vuelve a tu pestaña de Mango' }),
    ).toBeInTheDocument();
    expect(screen.getByText('· vuelta desde Microsoft')).toBeInTheDocument();
    const [sent] = tab.heard;
    // Only the session id and the page's reference.
    expect(sent).toMatchObject({ kind: 'return', session_id: SESSION });
    expect(Object.keys(sent ?? {}).sort()).toEqual(['kind', 'ref', 'session_id']);
    // The page never calls mango-api, and keeps nothing.
    expect(call).not.toHaveBeenCalled();
    expect(window.sessionStorage.length + window.localStorage.length).toBe(0);
    expect(
      screen.getByText(
        'Tu cuenta de Azure DevOps quedó conectada. En la pestaña donde pulsaste «Conectar», envía tu pregunta otra vez. Esta ya no hace falta.',
      ),
    ).toBeInTheDocument();
    await waitFor(
      () => {
        expect(close).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );
    // The browser kept it open: it says so instead of the button, and never opens Mango.
    expect(
      await screen.findByText(
        'El navegador no deja que Mango cierre esta pestaña. Ciérrala tú: tu pestaña de Mango ya está al día.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cerrar esta pestaña' })).not.toBeInTheDocument();
    tab.close();
  });

  it('asks to do it again when no tab took it', async () => {
    capture(`?session_id=${SESSION}`);
    const tab = waitingTab(null);
    renderWith(<ConnectReturnPage />, apiWith([]), '/conexiones/vuelta');
    expect(
      await screen.findByRole(
        'heading',
        { name: 'Pídelo de nuevo desde Mango' },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir Mango' })).toBeInTheDocument();
    tab.close();
  });

  it.each([
    ['expired', 'El enlace venció'],
    ['ambiguous', 'No se pudo saber qué conexión terminar'],
    ['notyours', 'Este enlace no es tuyo'],
    ['error', 'No se pudo conectar tu cuenta'],
  ])('says what the tab answered: %s', async (answer, title) => {
    capture(`?session_id=${SESSION}`);
    const tab = waitingTab(answer);
    renderWith(<ConnectReturnPage />, apiWith([]), '/conexiones/vuelta');
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.queryByText('· vuelta desde Microsoft')).not.toBeInTheDocument();
    tab.close();
  });

  it('asks to do it again after a reload, when nothing came back in memory', async () => {
    renderWith(<ConnectReturnPage />, apiWith([]), '/conexiones/vuelta');
    expect(
      await screen.findByRole('heading', { name: 'Pídelo de nuevo desde Mango' }),
    ).toBeInTheDocument();
  });

  it('says the provider did not authorize it, and tells the waiting tab', async () => {
    capture('?error=access_denied');
    const tab = waitingTab(null);
    renderWith(<ConnectReturnPage />, apiWith([]), '/conexiones/vuelta');
    expect(
      await screen.findByRole('heading', { name: 'El proveedor no autorizó la conexión' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(tab.heard).toEqual([{ kind: 'provider', result: 'denied' }]);
    });
    tab.close();
  });
});

describe('links of a remote answer (A1)', () => {
  const sources = [
    { service: 'Azure DevOps', linkHosts: ['dev.azure.com'], organizations: ['empresa'] },
  ];

  it('marks a link of another organization and asks with «Cancelar» first', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(
      <ChatMarkdown remote={sources}>
        {
          'Mira [el tablero](https://dev.azure.com/otra/_signin) y [la wiki](https://dev.azure.com/empresa/w).'
        }
      </ChatMarkdown>,
    );
    const other = screen.getByRole('button', { name: 'el tablero' });
    expect(other).toHaveAttribute('data-host-kind', 'other');
    expect(other).toHaveAttribute('data-host', 'dev.azure.com/otra');
    expect(screen.getByRole('button', { name: 'la wiki' })).toHaveAttribute(
      'data-host-kind',
      'service',
    );
    await userEvent.click(other);
    const dialog = screen.getByRole('dialog', { name: 'Abrir enlace externo' });
    expect(within(dialog).getByText('Otra organización')).toBeInTheDocument();
    expect(within(dialog).getByText(/no los escribas/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveClass('btn-primary');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Abrir de todas formas' }));
    expect(open).toHaveBeenCalledWith(
      'https://dev.azure.com/otra/_signin',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('says the company organization and opens it as the main action', async () => {
    render(
      <ChatMarkdown remote={sources}>{'[wiki](https://dev.azure.com/empresa/w)'}</ChatMarkdown>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'wiki' }));
    const dialog = screen.getByRole('dialog', { name: 'Abrir enlace externo' });
    expect(
      within(dialog).getByText(/Tu organización de Azure DevOps \(empresa\)/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Abrir enlace' })).toHaveClass('btn-primary');
  });

  it('keeps the plain dialog when the answer read no remote service', async () => {
    render(<ChatMarkdown>{'[wiki](https://dev.azure.com/empresa/w)'}</ChatMarkdown>);
    const link = screen.getByRole('button', { name: 'wiki' });
    expect(link).not.toHaveAttribute('data-host-kind');
    await userEvent.click(link);
    expect(screen.queryByText('Te lleva a')).not.toBeInTheDocument();
  });

  it('takes out the links of a turn that asked to connect, but those of the company (round 25)', async () => {
    render(
      <ChatMarkdown strip={sources}>
        {
          'Autoriza [aquí](https://azdevops-authorize.example.com/oauth/consent), mira [el tablero](https://dev.azure.com/otra/x) o [la wiki](https://dev.azure.com/empresa/w).'
        }
      </ChatMarkdown>,
    );
    const invented = screen.getByText('aquí');
    expect(invented.tagName).toBe('SPAN');
    expect(invented).toHaveClass('rm-nolink');
    expect(invented).toHaveAttribute(
      'title',
      'Enlace quitado por Mango · azdevops-authorize.example.com',
    );
    expect(screen.getByText('el tablero')).toHaveAttribute(
      'title',
      'Enlace quitado por Mango · dev.azure.com/otra',
    );
    expect(screen.queryByRole('button', { name: 'aquí' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'la wiki' })).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Mango desactivó 2 enlaces del agente. Para conectar tu cuenta usa solo «Conectar», en el aviso de Mango.',
      ),
    ).toBeInTheDocument();
  });

  it('marks nothing and opens nothing while the connections are read (design round 26)', () => {
    render(
      <ChatMarkdown strip="pending">
        {'Autoriza [aquí](https://azdevops-authorize.example.com/oauth/consent).'}
      </ChatMarkdown>,
    );
    const link = screen.getByText('aquí');
    expect(link.tagName).toBe('SPAN');
    expect(link).toHaveClass('rm-linkwait');
    expect(link).not.toHaveAttribute('title');
    expect(screen.queryByRole('button', { name: 'aquí' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Mango desactivó/)).not.toBeInTheDocument();
  });

  it('keeps the links closed and offers to check again when the connections failed (design round 27)', async () => {
    const reload = vi.fn();
    const value = {
      status: 'error',
      list: [],
      ensure: vi.fn(),
      reload,
    } as unknown as ConnectionsValue;
    const { result } = renderHook(() => useStripSources(['RMT-1']), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ConnectionsContext value={value}>{children}</ConnectionsContext>
      ),
    });
    expect(result.current).toBe('failed');
    render(
      <ConnectionsContext value={value}>
        <ChatMarkdown strip="failed">
          {'Autoriza [aquí](https://azdevops-authorize.example.com/oauth/consent).'}
        </ChatMarkdown>
      </ConnectionsContext>,
    );
    const link = screen.getByText('aquí');
    expect(link.tagName).toBe('SPAN');
    expect(link).toHaveClass('rm-linkwait');
    expect(screen.queryByText(/Mango desactivó/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /Mango no pudo comprobar los enlaces del agente, así que no se pueden abrir\./,
      ),
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Volver a comprobar' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('says one link in the singular', async () => {
    render(<ChatMarkdown strip={[]}>{'[wiki](https://dev.azure.com/empresa/w)'}</ChatMarkdown>);
    expect(screen.queryByRole('button', { name: 'wiki' })).not.toBeInTheDocument();
    expect(
      await screen.findByText(
        'Mango desactivó un enlace del agente. Para conectar tu cuenta usa solo «Conectar», en el aviso de Mango.',
      ),
    ).toBeInTheDocument();
  });
});
