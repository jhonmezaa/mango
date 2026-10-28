import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { McpCatalogPage } from '../mcpCatalog/McpCatalogPage';
import { catalog } from '../mcpCatalog/testFixtures';
import type { RemoteCatalog } from './model';
import {
  CALLBACK,
  CHANGE,
  ME,
  REG_ID,
  XSS,
  emptyRemoteCatalog,
  inDays,
  pendingRegistration,
  registration,
  remoteCatalog,
  request,
} from './testFixtures';

const SECRET = 'super-secret-value-9';
const GROUPS = { items: [{ id: 'finops-central' }, { id: 'hr' }] };

/**
 * An API with state, as the real one: each write answers with `after` (or fails with an error)
 * and the next read returns it too.
 */
function apiWith(initial: RemoteCatalog, writes: Record<string, RemoteCatalog | Error> = {}) {
  let current = initial;
  return vi.fn((operation: string) => {
    if (operation === 'getCatalog') return Promise.resolve(catalog([]));
    if (operation === 'getRemoteCatalog') return Promise.resolve(current);
    if (operation === 'listGroups') return Promise.resolve(GROUPS);
    const answer = writes[operation];
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${operation}`));
    if (answer instanceof Error) return Promise.reject(answer);
    current = answer;
    return Promise.resolve(answer);
  });
}

function writesOf(call: ReturnType<typeof vi.fn>) {
  return call.mock.calls.filter(
    ([operation]) =>
      !['getCatalog', 'getRemoteCatalog', 'listGroups'].includes(operation as string),
  );
}

function renderAt(path: string, call: ReturnType<typeof vi.fn>, isAdmin = true) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders
      session={sessionValue({ api, me: { ...baseMe, user_id: ME, is_admin: isAdmin } })}
      path={path}
    >
      <Routes>
        <Route path="/mcp/*" element={<McpCatalogPage />} />
      </Routes>
    </TestProviders>,
  );
  return userEvent.setup();
}

async function panel() {
  return screen.findByRole('dialog');
}

describe('Servicios externos', () => {
  it('shows each profile as a card, with its status and the organization', async () => {
    const call = apiWith(remoteCatalog([registration()]));
    const user = renderAt('/mcp/remote', call, false);
    const card = await screen.findByRole('button', { name: /^Azure DevOps/ });
    expect(card).toHaveTextContent('Operado por Microsoft · mcp.dev.azure.com');
    expect(card).toHaveTextContent('Habilitado');
    expect(card).toHaveTextContent('Habilitado para contoso · 1 grupo');
    expect(card).toHaveTextContent('Los datos salen de AWS');
    await user.click(card);
    const drawer = await panel();
    // What the signed profile says, not the design's example.
    expect(drawer).toHaveTextContent('.default (delegado, lectura)');
    expect(drawer).toHaveTextContent('wit_work_item');
    expect(drawer).toHaveTextContent(
      'Solo los administradores pueden habilitar servicios externos.',
    );
    expect(
      within(drawer).queryByRole('button', { name: /Habilitar para una organización/ }),
    ).toBeNull();
  });

  it('asks in two steps: checks the form, sends the secret once and shows the callback URL', async () => {
    const after = remoteCatalog([
      pendingRegistration({ own: true, requested_by: ME, organization: 'contoso' }),
    ]);
    const call = apiWith(emptyRemoteCatalog(), { requestRemoteRegistration: after });
    const user = renderAt('/mcp/remote/azure-devops', call);
    const drawer = await panel();
    await user.click(
      within(drawer).getByRole('button', { name: /Habilitar para una organización/ }),
    );

    const secret = within(drawer).getByLabelText('Secreto de la app');
    expect(secret).toHaveAttribute('type', 'password');
    expect(secret).toHaveAttribute('autocomplete', 'off');

    await user.type(
      within(drawer).getByLabelText('Organización de Azure DevOps'),
      'dev.azure.com/contoso',
    );
    await user.click(within(drawer).getByRole('button', { name: 'Enviar solicitud' }));
    expect(within(drawer).getByText('Solo el nombre, sin la URL')).toBeInTheDocument();
    expect(within(drawer).getAllByText(/Debe ser un GUID/)).toHaveLength(2);
    expect(within(drawer).getByText('Elige al menos un grupo')).toBeInTheDocument();
    expect(writesOf(call)).toEqual([]);

    const org = within(drawer).getByLabelText('Organización de Azure DevOps');
    await user.clear(org);
    await user.type(org, 'contoso');
    await user.type(
      within(drawer).getByLabelText('Tenant de Entra (tenantId)'),
      '00000000-0000-4000-8000-000000000001',
    );
    await user.type(
      within(drawer).getByLabelText('Id de la app (clientId)'),
      '00000000-0000-4000-8000-00000000000A',
    );
    await user.type(secret, SECRET);
    await user.click(within(drawer).getByRole('button', { name: 'finops-central' }));
    await user.click(within(drawer).getByRole('button', { name: 'Enviar solicitud' }));

    await waitFor(() => {
      expect(writesOf(call)).toHaveLength(1);
    });
    const [, input] = writesOf(call)[0] as [
      string,
      { path: unknown; body: Record<string, unknown> },
    ];
    expect(input.path).toEqual({ profile: 'azure-devops' });
    expect(input.body).toMatchObject({
      organization: 'contoso',
      tenant_id: '00000000-0000-4000-8000-000000000001',
      client_id: '00000000-0000-4000-8000-00000000000a',
      client_secret: SECRET,
      toolsets: ['core', 'wit', 'wiki'],
      groups: ['finops-central'],
    });
    // Step 2: the callback URL of Identity to paste in Entra, and the secret is gone.
    expect(await within(drawer).findByText('Solicitud enviada.')).toBeInTheDocument();
    expect(within(drawer).getByText(CALLBACK)).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Copiar' })).toBeInTheDocument();
    expect(
      within(drawer).getByText('Otra persona administradora tiene que aprobarlo.'),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('shows the error of the API with its own text', async () => {
    const call = apiWith(emptyRemoteCatalog(), {
      requestRemoteRegistration: new ApiError(409, 'remote_exists', 'raw'),
    });
    const user = renderAt('/mcp/remote/azure-devops', call);
    const drawer = await panel();
    await user.click(
      within(drawer).getByRole('button', { name: /Habilitar para una organización/ }),
    );
    await user.type(within(drawer).getByLabelText('Organización de Azure DevOps'), 'contoso');
    await user.type(
      within(drawer).getByLabelText('Tenant de Entra (tenantId)'),
      '00000000-0000-4000-8000-000000000001',
    );
    await user.type(
      within(drawer).getByLabelText('Id de la app (clientId)'),
      '00000000-0000-4000-8000-000000000002',
    );
    await user.type(within(drawer).getByLabelText('Secreto de la app'), SECRET);
    await user.click(within(drawer).getByRole('button', { name: 'finops-central' }));
    await user.click(within(drawer).getByRole('button', { name: 'Enviar solicitud' }));
    const alert = await within(drawer).findByText(
      'Azure DevOps ya está habilitado para esa organización.',
    );
    expect(alert).not.toHaveTextContent('raw');
  });

  it('approves the request of another administrator', async () => {
    const after = remoteCatalog([registration({ status: 'creating' })]);
    const call = apiWith(remoteCatalog([pendingRegistration()]), { approveRemoteRequest: after });
    const user = renderAt(`/mcp/remote/azure-devops/${REG_ID}`, call);
    const drawer = await panel();
    expect(drawer).toHaveTextContent('1 · Pedido por otra@example.com');
    await user.click(within(drawer).getByRole('button', { name: 'Aprobar' }));
    await waitFor(() => {
      expect(writesOf(call)).toEqual([
        ['approveRemoteRequest', { path: { reg: REG_ID, change_id: CHANGE }, body: {} }],
      ]);
    });
    expect(await within(drawer).findByText(/Mango está creando la conexión/)).toBeInTheDocument();
  });

  it('lets who asked withdraw, never approve', async () => {
    const call = apiWith(remoteCatalog([pendingRegistration({ own: true, requested_by: ME })]), {
      withdrawRemoteRequest: emptyRemoteCatalog(),
    });
    const user = renderAt(`/mcp/remote/azure-devops/${REG_ID}`, call);
    const drawer = await panel();
    expect(within(drawer).queryByRole('button', { name: 'Aprobar' })).toBeNull();
    await user.click(within(drawer).getByRole('button', { name: 'Retirar solicitud' }));
    await waitFor(() => {
      expect(writesOf(call)[0]?.[0]).toBe('withdrawRemoteRequest');
    });
  });

  it('asks for a reason to reject', async () => {
    const call = apiWith(remoteCatalog([pendingRegistration()]), {
      rejectRemoteRequest: emptyRemoteCatalog(),
    });
    const user = renderAt(`/mcp/remote/azure-devops/${REG_ID}`, call);
    const drawer = await panel();
    await user.click(within(drawer).getByRole('button', { name: 'Rechazar' }));
    await user.click(within(drawer).getByRole('button', { name: 'Rechazar' }));
    expect(within(drawer).getByText('El motivo es obligatorio')).toBeInTheDocument();
    await user.type(within(drawer).getByLabelText('Motivo del rechazo'), 'Pide escritura');
    await user.click(within(drawer).getByRole('button', { name: 'Rechazar' }));
    await waitFor(() => {
      expect(writesOf(call)).toEqual([
        [
          'rejectRemoteRequest',
          { path: { reg: REG_ID, change_id: CHANGE }, body: { reason: 'Pide escritura' } },
        ],
      ]);
    });
  });

  it('warns about the secret and rotates it without approval', async () => {
    const reg = registration({ secret_expires_on: inDays(5), secret_level: 'd7' });
    const call = apiWith(remoteCatalog([reg]), {
      rotateRemoteSecret: remoteCatalog([registration({ secret_expires_on: inDays(180) })]),
    });
    const user = renderAt(`/mcp/remote/azure-devops/${REG_ID}`, call);
    const drawer = await panel();
    expect(within(drawer).getByRole('status')).toHaveTextContent(
      'El secreto de la app de Entra vence en 5 días',
    );
    await user.click(
      within(drawer).getAllByRole('button', { name: 'Rotar secreto' })[0] as HTMLElement,
    );
    const modal = await screen.findByRole('dialog', { name: 'Rotar secreto de la app de Entra' });
    const field = within(modal).getByLabelText('Secreto nuevo');
    expect(field).toHaveAttribute('type', 'password');
    await user.type(field, SECRET);
    await user.click(within(modal).getByRole('button', { name: 'Guardar secreto' }));
    await waitFor(() => {
      expect(writesOf(call)).toHaveLength(1);
    });
    expect(writesOf(call)[0]).toEqual([
      'rotateRemoteSecret',
      {
        path: { reg: REG_ID },
        body: {
          version: 4,
          client_secret: SECRET,
          secret_expires_on: expect.any(String) as string,
        },
      },
    ]);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Rotar secreto de la app de Entra' })).toBeNull();
    });
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('changes the tenant or app with the same toolsets and groups', async () => {
    const after = remoteCatalog([
      registration({ pending: request({ kind: 'replace_app', own: true, requested_by: ME }) }),
    ]);
    const call = apiWith(remoteCatalog([registration()]), { requestRemoteChange: after });
    const user = renderAt(`/mcp/remote/azure-devops/${REG_ID}`, call);
    const drawer = await panel();
    await user.click(within(drawer).getByRole('button', { name: 'Cambiar tenant o app' }));
    expect(within(drawer).getByLabelText('Organización de Azure DevOps')).toBeDisabled();
    // Design round 24: reconnecting is announced and the groups are shown, not editable.
    expect(
      within(drawer).getByText(
        'Al aprobarse, todas las personas tendrán que conectar su cuenta otra vez.',
      ),
    ).toBeInTheDocument();
    expect(within(drawer).queryByRole('checkbox', { name: /Work items/ })).toBeNull();
    await user.type(
      within(drawer).getByLabelText('Tenant de Entra (tenantId)'),
      '00000000-0000-4000-8000-000000000009',
    );
    await user.type(
      within(drawer).getByLabelText('Id de la app (clientId)'),
      '00000000-0000-4000-8000-000000000008',
    );
    await user.type(within(drawer).getByLabelText('Secreto de la app'), SECRET);
    await user.click(within(drawer).getByRole('button', { name: 'Enviar solicitud' }));
    await waitFor(() => {
      expect(writesOf(call)).toHaveLength(1);
    });
    const [, input] = writesOf(call)[0] as [string, { body: Record<string, unknown> }];
    expect(input.body).toMatchObject({ kind: 'replace_app', version: 4 });
    expect(input.body).not.toHaveProperty('toolsets');
    expect(await within(drawer).findByText('Solicitud enviada.')).toBeInTheDocument();
  });

  it('asks to change the groups with two approvals and shows the change (round 24)', async () => {
    const reg = registration();
    const pending = request({
      kind: 'params',
      own: false,
      toolsets: [...reg.toolsets.slice(1)],
      previous_toolsets: [...reg.toolsets],
      groups: [...reg.groups, 'bu-plataforma'],
      previous_groups: [...reg.groups],
    });
    const after = remoteCatalog([registration({ pending })]);
    const call = apiWith(remoteCatalog([reg]), { requestRemoteParams: after });
    const user = renderAt(`/mcp/remote/azure-devops/${REG_ID}`, call);
    const drawer = await panel();
    await user.click(within(drawer).getByRole('button', { name: 'Cambiar grupos' }));
    // Nothing changed yet: the design's own text, and nothing is sent.
    await user.click(within(drawer).getByRole('button', { name: 'Enviar solicitud' }));
    expect(await within(drawer).findByText('No cambiaste ningún grupo.')).toBeInTheDocument();
    expect(writesOf(call)).toHaveLength(0);
    await user.click(within(drawer).getAllByRole('checkbox')[0] as HTMLElement);
    await user.click(within(drawer).getByRole('button', { name: 'Enviar solicitud' }));
    await waitFor(() => {
      expect(writesOf(call)).toHaveLength(1);
    });
    const [operation, input] = writesOf(call)[0] as [string, { body: Record<string, unknown> }];
    expect(operation).toBe('requestRemoteParams');
    expect(input.body).toMatchObject({ version: reg.version, groups: reg.groups });
    expect(await within(drawer).findByText('cambios')).toBeInTheDocument();
    expect(within(drawer).getByText('+ bu-plataforma')).toBeInTheDocument();
  });

  it('asks for a reason to disable', async () => {
    const call = apiWith(remoteCatalog([registration()]), {
      disableRemote: remoteCatalog([registration({ status: 'disabling' })]),
    });
    const user = renderAt(`/mcp/remote/azure-devops/${REG_ID}`, call);
    const drawer = await panel();
    await user.click(within(drawer).getByRole('button', { name: 'Deshabilitar' }));
    const modal = await screen.findByRole('dialog', { name: 'Deshabilitar Azure DevOps' });
    await user.click(within(modal).getByRole('button', { name: 'Deshabilitar' }));
    expect(within(modal).getByText('El motivo es obligatorio')).toBeInTheDocument();
    await user.type(within(modal).getByLabelText('Motivo'), 'Pausa');
    await user.click(within(modal).getByRole('button', { name: 'Deshabilitar' }));
    await waitFor(() => {
      expect(writesOf(call)).toEqual([
        ['disableRemote', { path: { reg: REG_ID }, body: { version: 4, reason: 'Pausa' } }],
      ]);
    });
  });

  it('renders text from the API as text', async () => {
    const call = apiWith(
      remoteCatalog([
        registration({
          history: [
            request({
              status: 'rejected',
              decision_reason: XSS,
              decided_at: '2026-10-01T00:00:00Z',
            }),
          ],
        }),
      ]),
    );
    renderAt('/mcp/remote/azure-devops', call);
    const drawer = await panel();
    expect(within(drawer).getByText(`«${XSS}»`)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('lists the requests in «Solicitudes pendientes» and counts them in the tab', async () => {
    const call = apiWith(remoteCatalog([pendingRegistration()]));
    const user = renderAt('/mcp', call);
    const tab = await screen.findByRole('tab', { name: /Solicitudes pendientes/ });
    await waitFor(() => {
      expect(tab).toHaveTextContent('1');
    });
    await user.click(tab);
    expect(await screen.findByText('servicios externos · 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Revisar/ }));
    expect(await panel()).toHaveTextContent('Azure DevOps · contoso');
  });
});
