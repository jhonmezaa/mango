import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { ChatMarkdown } from '../../components/ChatMarkdown';
import { sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { ConnectCard } from './ConnectCard';
import { useConnections } from './ConnectionsContext';
import { ConnectionsProvider } from './ConnectionsProvider';
import { ConnectReturnPage } from './ConnectReturnPage';
import { captureConsentReturn, resetConsentReturn } from './consentReturn';
import type { Connection } from './model';
import { consentNavigation } from './navigation';
import { connection } from './testFixtures';

const REG = 'abcdefghij23';
const CONSENT =
  'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/authorize?request_uri=x';
const SESSION = 'urn:ietf:params:oauth:request_uri:abc123';

type Answers = Record<string, (input: unknown) => Promise<unknown>>;

function apiWith(list: Connection[], answers: Answers = {}) {
  return vi.fn((operation: string, input: unknown) => {
    if (operation === 'listMyConnections') return Promise.resolve({ connections: [...list] });
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

function renderWith(children: ReactNode, call: ReturnType<typeof vi.fn>, path = '/') {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders session={sessionValue({ api })} path={path}>
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

afterEach(() => {
  vi.restoreAllMocks();
  resetConsentReturn();
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
    ]);
    renderWith(<OpenMine />, call);
    await userEvent.click(screen.getByRole('button', { name: 'open mine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mis conexiones' });
    expect(await within(dialog).findByText('No has conectado tu cuenta.')).toBeInTheDocument();
    expect(within(dialog).getByText(/^Conectado/)).toBeInTheDocument();
    expect(
      within(dialog).getByText('Un administrador deshabilitó Azure DevOps.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/tiene que renovar la configuración/)).toBeInTheDocument();
    // Only the row that is not connected can connect. «Desconectar» (D97) on the connected row
    // and, by the owner's choice, on the one with the app's secret expired.
    expect(within(dialog).getAllByRole('button', { name: 'Conectar' })).toHaveLength(1);
    expect(within(dialog).getAllByRole('button', { name: 'Desconectar' })).toHaveLength(2);
    expect(within(dialog).getByText(/vas a iniciar sesión en Microsoft/)).toBeInTheDocument();
  });

  it('says an account was already connected without leaving (A6)', async () => {
    const go = vi.spyOn(consentNavigation, 'go').mockImplementation(() => undefined);
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
    expect(go).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith('connectMyAccount', { path: { reg: REG }, body: {} });
  });

  it('leaves for the consent URL in the same tab only when it is the AgentCore host', async () => {
    const go = vi.spyOn(consentNavigation, 'go').mockImplementation(() => undefined);
    const open = vi.spyOn(window, 'open');
    const call = apiWith([connection()], {
      connectMyAccount: () =>
        Promise.resolve({
          status: 'consent_required',
          authorization_url: CONSENT,
          expires_at: null,
        }),
    });
    renderWith(<OpenMine />, call);
    await userEvent.click(screen.getByRole('button', { name: 'open mine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mis conexiones' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Conectar' }));
    await waitFor(() => {
      expect(go).toHaveBeenCalledWith(CONSENT);
    });
    expect(within(dialog).getByText('Abriendo Microsoft…')).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it('never opens a consent URL of another host', async () => {
    const go = vi.spyOn(consentNavigation, 'go').mockImplementation(() => undefined);
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
    expect(go).not.toHaveBeenCalled();
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
    renderWith(<ConnectCard registrationId={REG} startedAt={Date.now()} />, call);
    await userEvent.click(await screen.findByRole('button', { name: /Conectar/ }));
    expect(await screen.findByText('Conectado. Vuelve a enviar tu pregunta.')).toBeInTheDocument();
  });

  it('says the design text of a refused connect', async () => {
    const call = apiWith([connection()], {
      connectMyAccount: () => Promise.reject(new ApiError(409, 'remote_disabled', 'x')),
    });
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

describe('the return from the provider', () => {
  function capture(search: string) {
    captureConsentReturn(
      { pathname: '/conexiones/vuelta', search, hash: '' },
      { replaceState: () => undefined, state: null },
    );
  }

  it("closes the consent with the person's session and says it is connected", async () => {
    capture(`?session_id=${SESSION}`);
    const call = apiWith([connection({ status: 'connected' })], {
      completeConsent: () =>
        Promise.resolve({ status: 'connected', registration_id: REG, profile_id: 'azure-devops' }),
    });
    renderWith(<ConnectReturnPage />, call, '/conexiones/vuelta');
    expect(
      await screen.findByRole('heading', {
        name: 'Listo, tu cuenta de Azure DevOps está conectada.',
      }),
    ).toBeInTheDocument();
    expect(call).toHaveBeenCalledWith('completeConsent', { body: { session_id: SESSION } });
    expect(call.mock.calls.filter(([operation]) => operation === 'completeConsent')).toHaveLength(
      1,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Mis conexiones' }));
    expect(await screen.findByRole('dialog', { name: 'Mis conexiones' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/);
  });

  it.each([
    [new ApiError(410, 'consent_expired', 'x'), 'El enlace venció'],
    [new ApiError(403, 'consent_not_yours', 'x'), 'Este enlace no es tuyo'],
    [new ApiError(502, 'identity_unavailable', 'x'), 'No se pudo conectar tu cuenta'],
  ])('says %s with the design text', async (error, title) => {
    capture(`?session_id=${SESSION}`);
    const call = apiWith([connection()], { completeConsent: () => Promise.reject(error) });
    renderWith(<ConnectReturnPage />, call, '/conexiones/vuelta');
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  });

  it('asks to press «Conectar» again when nothing came back in memory, unnamed', async () => {
    const call = apiWith([connection()]);
    renderWith(<ConnectReturnPage />, call, '/conexiones/vuelta');
    expect(
      await screen.findByRole('heading', { name: 'Vuelve a pulsar «Conectar»' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('· vuelta desde Microsoft')).not.toBeInTheDocument();
    expect(call).not.toHaveBeenCalledWith('completeConsent', expect.anything());
  });

  it('says the provider did not authorize it', async () => {
    capture('?error=access_denied');
    renderWith(<ConnectReturnPage />, apiWith([connection()]), '/conexiones/vuelta');
    expect(
      await screen.findByRole('heading', { name: 'Microsoft no autorizó la conexión' }),
    ).toBeInTheDocument();
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
});
