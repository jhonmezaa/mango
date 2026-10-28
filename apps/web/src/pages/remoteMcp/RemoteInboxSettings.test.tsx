import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { InboxPage } from '../inbox/InboxPage';
import type { RemoteCatalog } from './model';
import { RemoteConnBlock } from './settings';
import {
  CHANGE_2,
  ME,
  REG_ID,
  REG_ID_2,
  inDays,
  pendingRegistration,
  registration,
  remoteCatalog,
  request,
} from './testFixtures';

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function apiWith(remote: RemoteCatalog, writes: Record<string, RemoteCatalog> = {}) {
  return vi.fn((operation: string) => {
    if (operation === 'getRemoteCatalog') return Promise.resolve(remote);
    if (operation === 'listInbox') {
      return Promise.resolve({ items: [], next_cursor: null, unread: 0, can_decide: true });
    }
    if (operation === 'unreadInbox') return Promise.resolve({ unread: 0, to_sign: 0 });
    const answer = writes[operation];
    return answer ? Promise.resolve(answer) : Promise.reject(new Error(`unexpected ${operation}`));
  });
}

function renderWith(
  element: ReactNode,
  call: ReturnType<typeof vi.fn>,
  path: string,
  isAdmin = true,
) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders
      session={sessionValue({ api, me: { ...baseMe, user_id: ME, is_admin: isAdmin } })}
      path={path}
    >
      <Routes>
        <Route path="inbox/*" element={element} />
        <Route path="settings" element={element} />
        <Route path="mcp/*" element={<Where />} />
      </Routes>
    </TestProviders>,
  );
  return userEvent.setup();
}

describe('Bandeja › servicios externos', () => {
  it('pins the requests of other administrators and opens them in the catalog', async () => {
    const call = apiWith(
      remoteCatalog([
        pendingRegistration(),
        registration({
          id: REG_ID_2,
          organization: 'fabrikam',
          pending: request({ id: CHANGE_2, own: true, requested_by: ME, organization: 'fabrikam' }),
        }),
      ]),
    );
    const user = renderWith(<InboxPage />, call, '/inbox');
    const listbox = await screen.findByRole('listbox', { name: 'Avisos' });
    const row = await within(listbox).findByRole('option', {
      name: /Te piden aprobar: Azure DevOps para contoso/,
    });
    // Their own request is not something to sign.
    expect(within(listbox).queryByText(/fabrikam/)).toBeNull();
    await user.click(row);
    await user.click(screen.getByRole('button', { name: /Revisar la solicitud/ }));
    expect(screen.getByTestId('where')).toHaveTextContent(`/mcp/remote/azure-devops/${REG_ID}`);
  });

  it('lists them in Aprobaciones', async () => {
    const call = apiWith(remoteCatalog([pendingRegistration()]));
    renderWith(<InboxPage />, call, '/inbox/approvals');
    const listbox = await screen.findByRole('listbox', { name: 'Avisos' });
    expect(
      await within(listbox).findByRole('option', { name: /Azure DevOps para contoso/ }),
    ).toBeInTheDocument();
  });

  it('leaves them out of Sin leer', async () => {
    const call = apiWith(remoteCatalog([pendingRegistration()]));
    renderWith(<InboxPage />, call, '/inbox/unread');
    expect(await screen.findByText('Nada por aquí.')).toBeInTheDocument();
    await waitFor(() => {
      expect(call.mock.calls.map(([operation]) => operation)).toContain('getRemoteCatalog');
    });
    expect(screen.queryByText(/Azure DevOps para contoso/)).toBeNull();
  });

  it('does not ask for them when the person is not an administrator', async () => {
    const call = apiWith(remoteCatalog([pendingRegistration()]));
    renderWith(<InboxPage />, call, '/inbox', false);
    await screen.findByRole('listbox', { name: 'Avisos' });
    expect(call.mock.calls.map(([operation]) => operation)).not.toContain('getRemoteCatalog');
  });
});

describe('Ajustes › Conectividad › Servicios externos', () => {
  it('lists the registrations with the warning of the secret, and links to the catalog', async () => {
    const call = apiWith(
      remoteCatalog([
        registration({ secret_expires_on: inDays(-2), secret_level: 'expired' }),
        pendingRegistration(),
      ]),
    );
    const user = renderWith(<RemoteConnBlock />, call, '/settings');
    expect(await screen.findByText('Servicios externos')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'El secreto de la app de Entra de Azure DevOps venció',
    );
    expect(screen.getByText('mcp.dev.azure.com/contoso')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /1 solicitud pendiente/ }));
    expect(screen.getByTestId('where')).toHaveTextContent(`/mcp/remote/azure-devops/${REG_ID}`);
  });

  it('says a failure by its code and that the installation has them off', async () => {
    const call = apiWith({
      ...remoteCatalog([registration({ status: 'failed', failure_code: 'target_failed' })]),
      enabled: false,
    });
    renderWith(<RemoteConnBlock />, call, '/settings');
    expect(
      await screen.findByText(
        'No se pudo habilitar Azure DevOps: la plataforma no pudo crear el servicio.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Reinténtalo desde el catálogo.')).toBeInTheDocument();
    expect(
      screen.getByText('Los servicios externos están apagados en esta instalación'),
    ).toBeInTheDocument();
  });

  it('says where to enable one when there is none', async () => {
    const call = apiWith(remoteCatalog([]));
    const user = renderWith(<RemoteConnBlock />, call, '/settings');
    await user.click(
      await screen.findByRole('button', { name: 'Catálogo de MCP › Servicios externos' }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('where')).toHaveTextContent('/mcp/remote');
    });
  });
});
