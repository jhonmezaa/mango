import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { McpCatalogPage } from './McpCatalogPage';
import type { Catalog } from './model';
import {
  ALL,
  CHANGE_ID,
  OTHER_ADMIN,
  XSS,
  anomaly,
  billing,
  catalog,
  costExplorer,
  documentation,
  ec2,
  health,
  logs,
  pack,
  pricing,
  request,
  support,
  tool,
} from './testFixtures';

function renderPage(call: ReturnType<typeof vi.fn>, isAdmin = true) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders session={sessionValue({ api, me: { ...baseMe, is_admin: isAdmin } })}>
      <McpCatalogPage />
    </TestProviders>,
  );
}

/** An API whose catalog is `initial` and whose writes answer with `next`. */
function apiWith(initial: Catalog, next: Partial<Record<string, Catalog | Error>> = {}) {
  return vi.fn((operation: string) => {
    const answer = operation === 'getCatalog' ? initial : next[operation];
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${operation}`));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
}

function writes(call: ReturnType<typeof vi.fn>) {
  return call.mock.calls.filter(([operation]) => operation !== 'getCatalog');
}

function rows() {
  return screen.getAllByRole('button').filter((button) => button.classList.contains('mc-tr'));
}

async function openServer(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${name}`) }));
  return { user, panel: screen.getByRole('dialog', { name }) };
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('McpCatalogPage', () => {
  it('lists the catalog in the design order, with what the API sent as text', async () => {
    renderPage(apiWith(catalog()));
    expect(await screen.findByRole('heading', { level: 1, name: 'Catálogo de MCP' })).toBeVisible();
    await screen.findByRole('tab', { name: 'Catálogo9' });
    expect(rows().map((row) => row.querySelector('.mk-name')?.textContent)).toEqual([
      'AWS Billing',
      'AWS Documentation',
      'AWS Health',
      'AWS Pricing',
      'AWS Support',
      'CloudWatch Logs Insights',
      'Cost Anomaly Detection',
      'EC2 Operations',
      'AWS Cost Explorer',
    ]);
    const ec2Row = screen.getByRole('button', { name: /^EC2 Operations/ });
    expect(ec2Row).toHaveTextContent('MCP pack · AWS Labs · ec2-operations');
    expect(ec2Row).toHaveTextContent('Habilitado');
    expect(ec2Row).toHaveTextContent('Actualización');
    expect(ec2Row).toHaveTextContent('3 · 2 de escritura');
    // Health has no data source yet.
    expect(ec2Row).toHaveTextContent('Próximamente');
    expect(ec2Row).not.toHaveTextContent('Sin datos');
    const connector = screen.getByRole('button', { name: /^AWS Cost Explorer/ });
    expect(connector).toHaveTextContent('Conector de Mango · cost-explorer');
    expect(connector).toHaveTextContent('2 · lectura');
    expect(screen.getByRole('tab', { name: 'Tools13' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Solicitudes pendientes3' })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows connecting an MCP by URL as "Próximamente"', async () => {
    renderPage(apiWith(catalog()));
    const button = await screen.findByRole('button', {
      name: 'Conectar MCP por URL, próximamente',
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('OAuth'));
  });

  it('filters by kind, status, level and search, and clears the filters', async () => {
    renderPage(apiWith(catalog()));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Conectores de Mango' }));
    expect(rows()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'MCP packs' }));
    expect(rows()).toHaveLength(8);

    const status = screen.getByRole('combobox', { name: 'Estado' });
    expect(within(status).getByRole('option', { name: 'Habilitado · 4' })).toBeInTheDocument();
    expect(within(status).getByRole('option', { name: 'Deshabilitando · 0' })).toBeInTheDocument();
    await user.selectOptions(status, 'enabled');
    expect(rows()).toHaveLength(3);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Nivel de datos' }), 'write');
    expect(rows().map((row) => row.querySelector('.mk-name')?.textContent)).toEqual([
      'EC2 Operations',
    ]);

    await user.type(screen.getByRole('textbox', { name: 'Buscar en el catálogo' }), 'nada');
    expect(screen.getByText('Nada coincide')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Limpiar' }));
    expect(rows()).toHaveLength(9);
    expect(screen.queryByRole('button', { name: 'Limpiar' })).toBeNull();
  });

  it('lists every tool, and only the ones in use when asked', async () => {
    renderPage(apiWith(catalog()));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Tools13' }));
    const toolRows = () =>
      screen.getAllByRole('button').filter((button) => button.classList.contains('mt-tr'));
    expect(toolRows()).toHaveLength(13);
    expect(screen.getByText('1 tool de escritura habilitada')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Escritura' }));
    expect(toolRows().map((row) => row.querySelector('.mono')?.textContent)).toEqual([
      'stop_instances',
      'reboot_instances',
    ]);
    await user.click(screen.getByRole('checkbox', { name: 'Solo habilitadas' }));
    expect(toolRows()).toHaveLength(1);
    await user.type(screen.getByRole('textbox', { name: 'Buscar tools' }), 'zzz');
    expect(screen.getByText('Ninguna tool coincide.')).toBeVisible();
  });

  it('groups the requests: what waits for this admin, then what they asked for', async () => {
    renderPage(apiWith(catalog()));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Solicitudes pendientes3' }));
    const panel = screen.getByRole('tabpanel');
    const theirs = within(panel).getByRole('heading', { name: 'esperan tu aprobación · 2' });
    const mine = within(panel).getByRole('heading', { name: 'pediste tú · 1' });
    expect(theirs.compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel).toHaveTextContent('Habilitar');
    expect(panel).toHaveTextContent(`Pedido por ${OTHER_ADMIN}`);
    expect(panel).toHaveTextContent('· region eu-west-1');
    expect(panel).toHaveTextContent(`“Conciliar facturas ${XSS}”`);
    expect(panel).toHaveTextContent('Actualización 1.2.0-1 → 1.3.0-1');
    expect(panel).toHaveTextContent('Agrega reboot_instances · escritura');
    expect(panel).toHaveTextContent('Quita start_instances');
    expect(panel).toHaveTextContent('Cambio de parámetros');
    expect(panel).toHaveTextContent('· region us-east-1 → eu-west-1');
    expect(document.querySelector('img')).toBeNull();

    await user.click(within(panel).getAllByRole('button', { name: 'Revisar' })[0] as HTMLElement);
    expect(screen.getByRole('dialog', { name: 'AWS Billing' })).toBeVisible();
  });

  it('says so when nothing is pending', async () => {
    renderPage(apiWith(catalog([pricing, costExplorer])));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Solicitudes pendientes' }));
    expect(screen.getByText('No hay solicitudes pendientes')).toBeVisible();
  });

  it('shows the detail of a pack: tools, permissions, agents, health and history', async () => {
    renderPage(apiWith(catalog()));
    const { panel } = await openServer('AWS Pricing');
    expect(panel).toHaveTextContent('MCP pack · AWS Labs · v1.0.0-1');
    expect(panel).toHaveTextContent(`Precios públicos de AWS. ${XSS}`);
    expect(panel).toHaveTextContent('tools · 2');
    expect(panel).toHaveTextContent('pricing:GetProducts');
    expect(panel).toHaveTextContent('Solo lectura.');
    expect(panel).toHaveTextContent('agentes que lo usan · 1');
    expect(panel).toHaveTextContent(XSS);
    expect(within(panel).getByRole('heading', { name: /^salud/ })).toHaveTextContent(
      'saludPróximamente',
    );
    expect(panel).toHaveTextContent('Todavía no hay datos de salud de los servidores MCP.');
    // The signed manifest of a pack brings no descriptions.
    expect(panel).toHaveTextContent(
      'El manifiesto firmado del pack solo trae nombre y tipo de acceso de cada tool.',
    );
    expect(panel).toHaveTextContent('Solicitadoana@example.com');
    expect(panel).toHaveTextContent(`Aprobado${OTHER_ADMIN}`);
    expect(panel.querySelector('img')).toBeNull();
    // No parameters: only disabling is offered.
    expect(within(panel).queryByRole('button', { name: 'Cambiar parámetros' })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Deshabilitar' })).toBeEnabled();
  });

  it('tells a connector of Mango is not managed from here', async () => {
    renderPage(apiWith(catalog()));
    const { panel } = await openServer('AWS Cost Explorer');
    expect(panel).toHaveTextContent(
      'Los conectores de Mango vienen instalados y no se deshabilitan desde aquí.',
    );
    expect(panel).not.toHaveTextContent('v1');
    expect(
      within(panel)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['']);
  });

  it('approves the request of another admin, after showing what it adds', async () => {
    const approved = catalog([
      { ...billing, pack: pack({ ...billing.pack, status: 'installing', pending: null }) },
    ]);
    const call = apiWith(catalog(), { approvePackRequest: approved });
    renderPage(call);
    const { user, panel } = await openServer('AWS Billing');
    expect(panel).toHaveTextContent(`${OTHER_ADMIN} pidió habilitarlo`);
    expect(panel).toHaveTextContent('con region eu-west-1');
    expect(panel).toHaveTextContent('Antes de aprobar');
    // ce:GetCostAndUsage is already used by the enabled connector.
    expect(panel).toHaveTextContent('Suma 1 permiso de AWS nuevo: billing:GetBillingData');
    expect(panel).toHaveTextContent(
      'Nivel «Datos de cuentas»: solo lo podrán usar agentes de roles centrales.',
    );
    await user.click(within(panel).getByRole('button', { name: 'Aprobar e instalar' }));
    await waitFor(() => {
      expect(writes(call)).toEqual([
        ['approvePackRequest', { path: { pack: 'aws-billing', change_id: CHANGE_ID }, body: {} }],
      ]);
    });
    expect(await screen.findByText('Aprobado · instalando AWS Billing')).toBeVisible();
    expect(within(panel).getByRole('status')).toHaveTextContent('Instalando');
  });

  it('asks for a reason to reject a request', async () => {
    const call = apiWith(catalog(), { rejectPackRequest: catalog([documentation]) });
    renderPage(call);
    const { user, panel } = await openServer('AWS Billing');
    await user.click(within(panel).getByRole('button', { name: 'Rechazar' }));
    const reason = within(panel).getByRole('textbox', { name: 'Motivo del rechazo' });
    expect(reason).toHaveFocus();
    await user.click(within(panel).getByRole('button', { name: 'Rechazar' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent('El motivo es obligatorio');
    expect(writes(call)).toEqual([]);
    await user.type(reason, '  Falta el responsable  ');
    await user.click(within(panel).getByRole('button', { name: 'Rechazar' }));
    await waitFor(() => {
      expect(writes(call)).toEqual([
        [
          'rejectPackRequest',
          {
            path: { pack: 'aws-billing', change_id: CHANGE_ID },
            body: { reason: 'Falta el responsable' },
          },
        ],
      ]);
    });
    expect(await screen.findByText('Solicitud rechazada')).toBeVisible();
  });

  it('does not offer the requester to decide their own request', async () => {
    const call = apiWith(catalog());
    renderPage(call);
    const { panel } = await openServer('AWS Health');
    expect(panel).toHaveTextContent(
      'Pediste cambiar region a eu-west-1: lo debe aprobar otro administrador.',
    );
    expect(within(panel).queryByRole('button', { name: 'Aprobar cambio' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Rechazar' })).toBeNull();
  });

  it('approves or rejects a parameter change of another admin without a reason', async () => {
    const theirs = {
      ...health,
      pack: pack({
        ...health.pack,
        pending: health.pack?.pending ? { ...health.pack.pending, own: false } : null,
      }),
    };
    const call = apiWith(catalog([theirs]), { rejectPackRequest: catalog([theirs]) });
    renderPage(call);
    const { user, panel } = await openServer('AWS Health');
    expect(panel).toHaveTextContent(`${OTHER_ADMIN} pide cambiar region de us-east-1 a eu-west-1.`);
    expect(within(panel).getByRole('button', { name: 'Aprobar cambio' })).toBeEnabled();
    await user.click(within(panel).getByRole('button', { name: 'Rechazar' }));
    await waitFor(() => {
      expect(writes(call)).toEqual([
        [
          'rejectPackRequest',
          { path: { pack: 'aws-health', change_id: CHANGE_ID }, body: { reason: null } },
        ],
      ]);
    });
    expect(await screen.findByText('Cambio rechazado')).toBeVisible();
  });

  it('requests a pack with the parameters of its manifest and an optional reason', async () => {
    const call = apiWith(catalog(), { requestPackEnablement: catalog() });
    renderPage(call);
    const { user, panel } = await openServer('AWS Documentation');
    await user.click(within(panel).getByRole('button', { name: 'Solicitar habilitación' }));
    const region = within(panel).getByRole('combobox', { name: 'Región' });
    expect(
      within(region)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['us-east-1', 'eu-west-1']);
    await user.selectOptions(region, 'eu-west-1');
    await user.type(
      within(panel).getByRole('textbox', { name: /Para qué se necesita/ }),
      'Consultar guías',
    );
    await user.click(within(panel).getByRole('button', { name: 'Enviar solicitud' }));
    await waitFor(() => {
      expect(writes(call)).toEqual([
        [
          'requestPackEnablement',
          {
            path: { pack: 'aws-documentation' },
            body: { version: 0, config: { region: 'eu-west-1' }, reason: 'Consultar guías' },
          },
        ],
      ]);
    });
    expect(
      await screen.findByText('Solicitud enviada · otro administrador debe aprobarla'),
    ).toBeVisible();
  });

  it('lists who is affected and asks for a reason before disabling', async () => {
    const call = apiWith(catalog(), { disablePack: catalog() });
    renderPage(call);
    const { user, panel } = await openServer('AWS Pricing');
    await user.click(within(panel).getByRole('button', { name: 'Deshabilitar' }));
    expect(panel).toHaveTextContent('Qué queda afectado');
    expect(panel).toHaveTextContent(`· 1 agente publicado con tools no disponibles: ${XSS}`);
    await user.click(within(panel).getByRole('button', { name: 'Deshabilitar' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent('El motivo es obligatorio');
    expect(writes(call)).toEqual([]);
    await user.type(
      within(panel).getByRole('textbox', { name: 'Motivo para deshabilitar' }),
      'Ya no se usa',
    );
    await user.click(within(panel).getByRole('button', { name: 'Deshabilitar' }));
    await waitFor(() => {
      expect(writes(call)).toEqual([
        [
          'disablePack',
          { path: { pack: 'aws-pricing' }, body: { version: 2, reason: 'Ya no se usa' } },
        ],
      ]);
    });
    expect(await screen.findByText('AWS Pricing deshabilitado')).toBeVisible();
  });

  it('shows a disabled pack with the agents that lost its tools and the last rejection', async () => {
    renderPage(apiWith(catalog()));
    const { panel } = await openServer('AWS Support');
    expect(panel).toHaveTextContent(
      'Deshabilitado. Un agente tiene sus tools como no disponibles: Soporte. Siguen publicados y responden sin ellas; al volver a habilitarlo las recuperan sin nueva revisión.',
    );
    expect(panel).toHaveTextContent(`Última solicitud rechazada por ${OTHER_ADMIN}: “${XSS}”`);
    expect(panel).toHaveTextContent('SoporteTools no disponibles');
    expect(panel).toHaveTextContent(`Deshabilitado${OTHER_ADMIN}`);
    expect(panel.querySelector('img')).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Solicitar habilitación' })).toBeEnabled();
  });

  it('retries a failed installation, showing the step and the code as text', async () => {
    const call = apiWith(catalog(), { retryPack: catalog() });
    renderPage(call);
    const { user, panel } = await openServer('Cost Anomaly Detection');
    expect(panel).toHaveTextContent(
      'No se pudo instalar. Paso «create_role». Código AccessDenied.',
    );
    await user.click(within(panel).getByRole('button', { name: 'Reintentar instalación' }));
    await waitFor(() => {
      expect(writes(call)).toEqual([
        ['retryPack', { path: { pack: 'cost-anomaly' }, body: { version: 2 } }],
      ]);
    });
    expect(await screen.findByText('Reintentando instalación')).toBeVisible();
  });

  it('says the previous version stays active when an update failed', async () => {
    const failed = {
      ...anomaly,
      enabled: true,
      pack: pack({ ...anomaly.pack, installed_version: '0.9.0-1', failure: 'interrupted' }),
    };
    renderPage(apiWith(catalog([failed])));
    const { panel } = await openServer('Cost Anomaly Detection');
    expect(panel).toHaveTextContent(
      'No se pudo instalar. Paso «create_role». La instalación se interrumpió. Sigue activa la versión 0.9.0-1.',
    );
  });

  it('shows an update with what it changes, and approves it', async () => {
    const call = apiWith(catalog(), { approvePackRequest: catalog() });
    renderPage(call);
    const { user, panel } = await openServer('EC2 Operations');
    expect(panel).toHaveTextContent('Actualización 1.2.0-1 → 1.3.0-1 cambia sus tools');
    expect(panel).toHaveTextContent(
      'Agrega: reboot_instances · escritura · Quita: start_instances',
    );
    expect(panel).toHaveTextContent(
      `Pedida por ${OTHER_ADMIN} · hace 42 min. Hasta aprobarla, sigue activa la versión 1.2.0-1.`,
    );
    expect(panel).toHaveTextContent('La versión 1.3.0-1 agrega:ec2:RebootInstances');
    // One list of permissions and write tools: it is not called "Lectura".
    expect(panel).not.toHaveTextContent('Solo lectura.');
    await user.click(within(panel).getByRole('button', { name: 'Aprobar actualización' }));
    await waitFor(() => {
      expect(writes(call)).toHaveLength(1);
    });
    expect(writes(call)[0]?.[0]).toBe('approvePackRequest');
    expect(await screen.findByText('Actualización aprobada')).toBeVisible();
  });

  it('asks for the update the release brings, for another administrator to approve', async () => {
    const unrequested = { ...ec2, pack: pack({ ...ec2.pack, pending: null }) };
    const call = apiWith(catalog([unrequested]), { requestPackUpdate: catalog() });
    renderPage(call);
    expect(
      (await screen.findByRole('button', { name: /^EC2 Operations/ })).textContent,
    ).not.toContain('Actualización');
    const { user, panel } = await openServer('EC2 Operations');
    // Nobody asked for it yet: there is nothing to approve, only to ask.
    expect(panel).not.toHaveTextContent('cambia sus tools');
    expect(within(panel).queryByRole('button', { name: 'Aprobar actualización' })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Pedir actualización a 1.3.0-1' }));
    await waitFor(() => {
      expect(writes(call)).toEqual([
        ['requestPackUpdate', { path: { pack: 'ec2-operations' }, body: { version: 4 } }],
      ]);
    });
    expect(
      await screen.findByText('Actualización pedida · otro administrador debe aprobarla'),
    ).toBeVisible();
  });

  it('does not offer the update while a request is pending, nor to who is not an admin', async () => {
    const pending = render(
      <TestProviders
        session={sessionValue({
          api: { call: apiWith(catalog()) } as unknown as ApiClient,
          me: { ...baseMe, is_admin: true },
        })}
      >
        <McpCatalogPage />
      </TestProviders>,
    );
    const first = await openServer('EC2 Operations');
    expect(within(first.panel).queryByRole('button', { name: /Pedir actualización/ })).toBeNull();
    pending.unmount();

    const unrequested = { ...ec2, pack: pack({ ...ec2.pack, pending: null }) };
    renderPage(apiWith(catalog([unrequested])), false);
    const { panel } = await openServer('EC2 Operations');
    expect(within(panel).queryByRole('button', { name: /Pedir actualización/ })).toBeNull();
  });

  it('explains an update that changes how the pack reaches data', async () => {
    const unrequested = { ...ec2, pack: pack({ ...ec2.pack, pending: null }) };
    const call = apiWith(catalog([unrequested]), {
      requestPackUpdate: new ApiError(409, 'identity_mode_changed', 'raw detail'),
    });
    renderPage(call);
    const { user, panel } = await openServer('EC2 Operations');
    await user.click(within(panel).getByRole('button', { name: /Pedir actualización/ }));
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent(
      'El pack cambió de modo de identidad. Deshabilítalo y vuelve a habilitarlo para aplicar el cambio.',
    );
    expect(alert).not.toHaveTextContent('raw detail');
  });

  it('lets the requester withdraw their request to enable, change parameters or update', async () => {
    const mine = (item: typeof billing) => ({
      ...item,
      pack: pack({ ...item.pack, pending: request({ ...item.pack?.pending, own: true }) }),
    });
    const cases = [
      ['AWS Billing', mine(billing), 'aws-billing'],
      ['AWS Health', health, 'aws-health'],
      ['EC2 Operations', mine(ec2), 'ec2-operations'],
    ] as const;
    for (const [name, item, id] of cases) {
      const call = apiWith(catalog([item]), { withdrawPackRequest: catalog() });
      const view = render(
        <TestProviders
          session={sessionValue({
            api: { call } as unknown as ApiClient,
            me: { ...baseMe, is_admin: true },
          })}
        >
          <McpCatalogPage />
        </TestProviders>,
      );
      const { user, panel } = await openServer(name);
      expect(within(panel).queryByRole('button', { name: /^Aprobar/ })).toBeNull();
      await user.click(within(panel).getByRole('button', { name: 'Retirar solicitud' }));
      await waitFor(() => {
        expect(writes(call)).toEqual([
          ['withdrawPackRequest', { path: { pack: id, change_id: CHANGE_ID }, body: {} }],
        ]);
      });
      expect(await screen.findByText('Solicitud retirada')).toBeVisible();
      view.unmount();
    }
  });

  it('says how each server over account data reaches them', async () => {
    renderPage(apiWith(catalog()));
    const billingRow = await screen.findByRole('button', { name: /^AWS Billing/ });
    expect(billingRow).toHaveTextContent('Datos de cuentasSolo centrales');
    expect(screen.getByRole('button', { name: /^AWS Cost Explorer/ })).toHaveTextContent(
      'Datos de cuentasPor usuario',
    );
    // Other data levels have no mode.
    const pricingRow = screen.getByRole('button', { name: /^AWS Pricing/ });
    expect(pricingRow).not.toHaveTextContent('Solo centrales');
    expect(pricingRow).not.toHaveTextContent('Por usuario');

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /Solicitudes pendientes/ }));
    expect(document.querySelector('.mc-req')).toHaveTextContent('Datos de cuentasSolo centrales');
    await user.click(screen.getByRole('tab', { name: /^Tools/ }));
    const toolRow = screen.getByRole('button', { name: /^list_invoices/ });
    expect(toolRow).toHaveTextContent('Datos de cuentasSolo centrales');

    await user.click(toolRow);
    const panel = screen.getByRole('dialog', { name: 'AWS Billing' });
    expect(panel).toHaveTextContent('Solo usuarios centralesSus tools responden por toda la');
    await user.click(within(panel).getByRole('button', { name: 'Cerrar' }));
    await user.click(screen.getByRole('button', { name: /^get_cost_and_usage/ }));
    const connector = screen.getByRole('dialog', { name: 'AWS Cost Explorer' });
    expect(connector).toHaveTextContent('Filtra por usuarioCada persona ve solo lo que su rol');
    // A connector says tool by tool who may call it.
    expect(connector).toHaveTextContent('get_cost_and_usageGasto real.Por usuarioLectura');
    expect(connector).toHaveTextContent(
      'get_savings_plans_utilizationSolo grupos centralesLectura',
    );
  });

  it('names the AWS services some tools need, without claiming to know their state', async () => {
    const enabled = {
      ...billing,
      enabled: true,
      tools: [
        ...billing.tools,
        tool('aws-billing', 'compute-optimizer', { requires_service: 'Compute Optimizer' }),
        tool('aws-billing', 'cost-optimization', { requires_service: 'Cost Optimization Hub' }),
      ],
      pack: pack({ status: 'enabled', installed_version: '0.9.3-1', lock_version: 2 }),
    };
    renderPage(apiWith(catalog([enabled])));
    const { panel } = await openServer('AWS Billing');
    expect(panel).toHaveTextContent(
      'Compute Optimizer y Cost Optimization Hub se activan aparte en la cuenta pagadora, y Mango no comprueba si lo están. Sus tools responden con error hasta que se activen en AWS; las demás funcionan.',
    );
    expect(panel).toHaveTextContent('compute-optimizerRequiere Compute OptimizerLectura');
    expect(panel).toHaveTextContent('cost-optimizationRequiere Cost Optimization HubLectura');
    expect(panel).toHaveTextContent('list_invoicesLectura');
  });

  // Since R6 (D54) every pack runs on the pack network: the provisioner no longer answers
  // `egress_allowlist_required`. Its network failures have no text of their own in the design.
  it.each(['egress_unavailable', 'external_egress_unsupported', 'runtime_network_mismatch'])(
    'shows the network failure %s of the provisioner with its code',
    async (failure) => {
      const failed = { ...anomaly, pack: pack({ ...anomaly.pack, failure }) };
      renderPage(apiWith(catalog([failed])));
      const { panel } = await openServer('Cost Anomaly Detection');
      expect(panel).toHaveTextContent(
        `No se pudo instalar. Paso «create_role». Código ${failure}.`,
      );
      expect(panel).not.toHaveTextContent('lista de salida de red');
    },
  );

  it('says a pack being disabled keeps its agents published', async () => {
    const disabling = { ...logs, pack: pack({ ...logs.pack, status: 'disabling' }) };
    renderPage(apiWith(catalog([disabling])));
    const { panel } = await openServer('CloudWatch Logs Insights');
    expect(within(panel).getByRole('status')).toHaveTextContent(
      'Deshabilitando. Los agentes que lo usan siguen publicados y responderán sin estas tools.',
    );
    expect(panel.querySelector('.mk-drawer-h, header')).toHaveTextContent('Deshabilitando');
  });

  it('asks for a parameter change only when something changes', async () => {
    const call = apiWith(catalog(), { requestPackParams: catalog() });
    renderPage(call);
    const { user, panel } = await openServer('EC2 Operations');
    await user.click(within(panel).getByRole('button', { name: 'Cambiar parámetros' }));
    const send = within(panel).getByRole('button', { name: 'Pedir cambio' });
    expect(send).toBeDisabled();
    await user.selectOptions(
      within(panel).getByRole('combobox', { name: 'Región · hoy us-east-1' }),
      'eu-west-1',
    );
    await user.click(send);
    await waitFor(() => {
      expect(writes(call)).toEqual([
        [
          'requestPackParams',
          {
            path: { pack: 'ec2-operations' },
            body: { version: 4, config: { region: 'eu-west-1' } },
          },
        ],
      ]);
    });
    expect(await screen.findByText('Cambio de parámetros enviado a aprobación')).toBeVisible();
  });

  it('keeps the form and reloads the catalog when it changed meanwhile', async () => {
    const call = apiWith(catalog(), {
      approvePackRequest: new ApiError(409, 'version_conflict', 'stale'),
    });
    renderPage(call);
    const { user, panel } = await openServer('AWS Billing');
    await user.click(within(panel).getByRole('button', { name: 'Aprobar e instalar' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Otro administrador hizo un cambio mientras tanto.',
    );
    expect(call.mock.calls.filter(([operation]) => operation === 'getCatalog')).toHaveLength(2);
  });

  it.each([
    ['same_approver', 403, 'Quien propone un cambio no puede aprobarlo'],
    ['release_changed', 409, 'La release ya no trae la versión que se pidió'],
    ['too_many_packs', 409, 'Se alcanzó el máximo de packs habilitados'],
    ['provisioner_unavailable', 503, 'la instalación no arrancó'],
    ['audit_unavailable', 503, 'No se pudo registrar la auditoría'],
  ])('explains %s without showing the server message', async (code, status, text) => {
    const call = apiWith(catalog(), {
      approvePackRequest: new ApiError(status, code, 'raw <b>server</b> message'),
    });
    renderPage(call);
    const { user, panel } = await openServer('AWS Billing');
    await user.click(within(panel).getByRole('button', { name: 'Aprobar e instalar' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent('raw');
  });

  it('reads the catalog again while the platform installs a pack', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const call = apiWith(catalog([logs]));
    renderPage(call);
    const { panel } = await openServer('CloudWatch Logs Insights');
    // Design: no sub-steps, only that it is installing and since when.
    expect(within(panel).getByRole('status')).toHaveTextContent(
      'Instalando · empezó hace 3 min. Puedes cerrar este panel.',
    );
    expect(call).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not poll when nothing is in progress', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const call = apiWith(catalog([pricing]));
    renderPage(call);
    await screen.findByRole('button', { name: /^AWS Pricing/ });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('lets a creator read the catalog, without requests or actions', async () => {
    // What the API sends to a creator: no requests, no history.
    const creatorView = ALL.map((item) =>
      item.pack
        ? {
            ...item,
            pack: pack({
              status: item.pack.status,
              version: item.pack.version,
              installed_version: item.pack.installed_version,
              lock_version: item.pack.lock_version,
              params: item.pack.params,
              update: item.pack.update,
            }),
          }
        : item,
    );
    const call = apiWith(catalog(creatorView));
    renderPage(call, false);
    const { panel } = await openServer('AWS Billing');
    expect(panel).toHaveTextContent(
      'Solo los administradores pueden habilitar, aprobar o deshabilitar MCP.',
    );
    expect(panel).not.toHaveTextContent('Antes de aprobar');
    expect(within(panel).queryByRole('button', { name: 'Aprobar e instalar' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Solicitudes pendientes' })).toBeInTheDocument();
  });

  it('shows the access notice when the API refuses the catalog', async () => {
    renderPage(
      vi.fn(() => Promise.reject(new ApiError(403, 'forbidden', 'no'))),
      false,
    );
    expect(await screen.findByText('No tienes acceso a esta sección')).toBeVisible();
  });

  it('offers to retry when the catalog cannot be loaded', async () => {
    let fail = true;
    const call = vi.fn(() =>
      fail
        ? Promise.reject(new ApiError(503, 'catalog_unavailable', 'x'))
        : Promise.resolve(catalog([support])),
    );
    renderPage(call);
    expect(await screen.findByText('No se pudo cargar el catálogo de MCP')).toBeVisible();
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: /^AWS Support/ })).toBeVisible();
  });
});
