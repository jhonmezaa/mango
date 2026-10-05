import type { OrgNode, OrgOut } from '@mango/api-client/types';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { OrgChartPage } from './OrgChartPage';

function agent(id: string, name: string, role: string, reportsTo: string | null): OrgNode {
  return {
    id,
    version: 1,
    name,
    role,
    description: `Descripción de ${name}`,
    category: 'Finanzas',
    icon: 'Money',
    color: 2,
    reports_to: reportsTo,
    can_use: true,
    can_edit: true,
    groups: [],
  };
}

const ORG: OrgOut = {
  root: 'platform',
  nodes: [
    agent('finops', 'FinOps', 'Analista FinOps', 'platform'),
    agent('k3fq7zr2m5xw6n4a', 'Savings Plans', 'Especialista en compromisos', 'finops'),
    agent('b6t2hd5yq7lc3vpe', 'Anomalías', 'Analista de anomalías', 'finops'),
    agent('p2ys6ke4c7dq3hzo', 'Etiquetado', 'Auditor de etiquetas', 'platform'),
  ],
};

function renderPage(
  call: (id: string) => Promise<unknown> = () => Promise.resolve(ORG),
  canCreate = false,
  isAdmin = false,
) {
  const spy = vi.fn(call);
  const view = render(
    <TestProviders
      session={sessionValue({
        api: { call: spy } as unknown as ApiClient,
        me: { ...baseMe, is_admin: isAdmin, can: { create_agent: canCreate } },
      })}
    >
      <OrgChartPage />
    </TestProviders>,
  );
  return { ...view, call: spy };
}

const nodeButton = (name: string) => screen.findByRole('button', { name, pressed: false });
const canvas = () => screen.getByRole('application');
const transform = () => (canvas().querySelector('.oc-tree') as HTMLElement).style.transform;
const stat = (label: string) =>
  (
    screen.getByText(label, { selector: '.oc-stats > div > span:first-child' })
      .parentElement as HTMLElement
  ).textContent;

describe('OrgChartPage', () => {
  it('draws the tree of GET /api/agents/org under the root «Platform Admin»', async () => {
    const { call } = renderPage();
    const root = await nodeButton('Platform Admin, Raíz · no es un agente');
    expect(call).toHaveBeenCalledWith('getOrg', {}, expect.anything());
    expect(call).toHaveBeenCalledTimes(1);

    // The root is the only node of the first level; FinOps and Etiquetado report to it.
    const tree = canvas().querySelector('.oc-tree > ul') as HTMLElement;
    expect(tree.children).toHaveLength(1);
    const rootItem = root.closest('li') as HTMLElement;
    expect(root.closest('.oc-node')).toHaveClass('root');
    const firstLevel = [...(rootItem.querySelector(':scope > ul') as HTMLElement).children];
    expect(firstLevel.map((item) => item.querySelector('.oc-name')?.textContent)).toEqual([
      'FinOps',
      'Etiquetado',
    ]);
    const finops = firstLevel[0] as HTMLElement;
    expect(
      [...finops.querySelectorAll(':scope > ul > li .oc-name')].map((item) => item.textContent),
    ).toEqual(['Savings Plans', 'Anomalías']);
    expect(within(finops).getByText('Especialista en compromisos')).toBeInTheDocument();

    expect(stat('Agentes')).toBe('Agentes4');
    expect(stat('Supervisores')).toBe('Supervisores1');
  });

  it('keeps what has no backend as "Próximamente", without example data', async () => {
    const { container } = renderPage();
    await nodeButton('FinOps, Analista FinOps');
    // Alerts, status legend and agent-to-agent delegation (D30).
    expect(stat('Con alertas')).toBe('Con alertasPróximamente');
    expect(container.querySelector('.oc-legend .soon-body')).toHaveAttribute('inert');
    const heading = screen.getByRole('heading', { name: /Delegaciones recientes/ });
    expect(within(heading).getByText('Próximamente')).toBeInTheDocument();
    // Delegation is one "Próximamente" card, without rows.
    const card = container.querySelector('.oc-deleg-soon') as HTMLElement;
    expect(card).toHaveTextContent('Delegación A2A');
    expect(card).toHaveTextContent(
      'Cuando un agente pueda delegar tareas a sus subordinados, aparecerán aquí.',
    );
    expect(within(card).getByText('Próximamente')).toBeInTheDocument();
    expect(within(card).queryByRole('button')).toBeNull();
    expect(container.querySelector('.oc-deleg')).toBeNull();
    expect(container.querySelector('.oc-pip')).toBeNull();
    expect(screen.queryByText(/hace \d+ min/)).toBeNull();
  });

  it('renders names and roles written by creators as text', async () => {
    const { container } = renderPage(() =>
      Promise.resolve({
        root: 'platform',
        nodes: [
          agent(
            'b6t2hd5yq7lc3vpe',
            'Anomalías <b>Retail</b>',
            '<img src=x onerror=alert(1)>',
            'platform',
          ),
        ],
      }),
    );
    const node = await nodeButton('Anomalías <b>Retail</b>, <img src=x onerror=alert(1)>');
    await userEvent.click(node);
    expect(screen.getAllByText('Anomalías <b>Retail</b>').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('.oc-page img, .oc-page b:not(.oc-stats b), script')).toBeNull();
  });

  it('opens the read-only panel of a node and closes it', async () => {
    renderPage();
    await userEvent.click(await nodeButton('FinOps, Analista FinOps'));
    const panel = screen.getByRole('complementary', { name: 'Detalle de FinOps' });
    expect(
      screen.getByRole('button', { name: 'FinOps, Analista FinOps', pressed: true }),
    ).toBeInTheDocument();
    expect(within(panel).getByText('Subordinados directos')).toBeInTheDocument();
    expect(
      within(panel)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Savings PlansEspecialista en compromisos', 'AnomalíasAnalista de anomalías']);
    expect(within(panel).getByText('Subordinados').previousElementSibling).toHaveTextContent('2');
    // What the API returns: description and category.
    expect(within(panel).getByText('Descripción de FinOps')).toBeInTheDocument();
    const rows = [...panel.querySelectorAll('.mk-kv')].map((row) => row.textContent);
    expect(rows).toEqual([
      'CategoríaFinanzas',
      'Estado—Próximamente',
      'Modelo—Próximamente',
      'Compartido con—Próximamente',
      'Presupuesto del mes—Próximamente',
      'Datos y permisos—Próximamente',
    ]);
    // Delegation and costs have no data: no control, no numbers.
    expect(within(panel).queryByRole('button', { name: /Delegar/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Costos' })).toBeNull();
    expect(within(panel).getByText('Enviadas').previousElementSibling).toHaveTextContent('—');
    expect(within(panel).getByText('Recibidas').previousElementSibling).toHaveTextContent('—');
    expect(panel).not.toHaveTextContent(/USD|\$|%/);
    expect(within(panel).getByRole('link', { name: 'Ver en Marketplace' })).toHaveAttribute(
      'href',
      '/marketplace',
    );
    // An agent the person may use has no notice.
    expect(within(panel).queryByRole('note')).toBeNull();

    await userEvent.click(within(panel).getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('complementary')).toBeNull();

    // A leaf has no subordinates; the root has no agent facts. Clicking again closes the panel.
    await userEvent.click(await nodeButton('Etiquetado, Auditor de etiquetas'));
    expect(screen.getByRole('complementary')).not.toHaveTextContent('Subordinados directos');
    await userEvent.click(await nodeButton('Platform Admin, Raíz · no es un agente'));
    const rootPanel = screen.getByRole('complementary', { name: 'Detalle de Platform Admin' });
    expect(within(rootPanel).queryByRole('link')).toBeNull();
    expect(
      within(rootPanel).getByText('Platform Admin es la raíz del organigrama, no un agente.'),
    ).toBeInTheDocument();
    expect(rootPanel.querySelector('.mk-kv')).toBeNull();
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Platform Admin, Raíz · no es un agente',
        pressed: true,
      }),
    );
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  const EDIT_NOTE = 'Solo quien lo creó o un administrador puede editarlo.';
  it.each([
    // May edit this agent (who created it or an administrator).
    [
      true,
      true,
      'Para usarlo, agrega uno de tus grupos en su Acceso (va con una versión nueva) o pide que te sumen a uno de esos grupos.',
    ],
    // A creator who did not create it.
    [
      true,
      false,
      'Para usarlo, pide a quien lo creó que agregue uno de tus grupos en su Acceso, o a un administrador que te sume a uno de esos grupos.',
    ],
    [false, false, 'Para usarlo, pide a un administrador que te agregue a uno de esos grupos.'],
  ])(
    'tells who sees an agent they cannot use why, and who uses it (creator: %s, may edit: %s)',
    async (canCreate, canEdit, how) => {
      const locked: OrgNode = {
        ...agent('p2ys6ke4c7dq3hzo', 'Etiquetado', 'Auditor de etiquetas', 'platform'),
        can_use: false,
        can_edit: canEdit,
        groups: ['bu-retail', '<b>x</b>'],
      };
      renderPage(() => Promise.resolve({ root: 'platform', nodes: [locked] }), canCreate);
      await userEvent.click(await nodeButton('Etiquetado, Auditor de etiquetas'));
      const panel = screen.getByRole('complementary', { name: 'Detalle de Etiquetado' });
      const box = within(panel).getByRole('note');
      expect(box).toHaveTextContent('No puedes usar este agente');
      expect(box).toHaveTextContent(
        'No estás en sus grupos ni entre sus personas, así que no aparece en tu Marketplace ni en el chat. El uso va por grupos y personas, también para quien lo creó y para administradores.',
      );
      // The groups are API text: never markup.
      expect(
        [...box.querySelectorAll('.oc-nouse-g span')].map((group) => group.textContent),
      ).toEqual(['bu-retail', '<b>x</b>']);
      expect(box.querySelector('b')).toBeNull();
      expect(box.querySelector('.oc-nouse-how')?.textContent).toBe(how);
      // Nothing to open in the Marketplace; "Editar" only for who may edit this agent, and a
      // creator who may not reads why.
      expect(within(panel).queryByRole('link', { name: 'Ver en Marketplace' })).toBeNull();
      expect(within(panel).queryAllByRole('link', { name: 'Editar' })).toHaveLength(
        canEdit ? 1 : 0,
      );
      expect(within(panel).queryAllByText(EDIT_NOTE)).toHaveLength(canCreate && !canEdit ? 1 : 0);
    },
  );

  it('keeps "Editar" from a creator on an agent they can use and did not create', async () => {
    const other: OrgNode = {
      ...agent('p2ys6ke4c7dq3hzo', 'Etiquetado', 'Auditor de etiquetas', 'platform'),
      can_edit: false,
    };
    renderPage(() => Promise.resolve({ root: 'platform', nodes: [other] }), true);
    await userEvent.click(await nodeButton('Etiquetado, Auditor de etiquetas'));
    const panel = screen.getByRole('complementary', { name: 'Detalle de Etiquetado' });
    expect(within(panel).queryByRole('link', { name: 'Editar' })).toBeNull();
    expect(within(panel).getByText(EDIT_NOTE)).toHaveClass('oc-edit-note');
    expect(within(panel).getByRole('link', { name: 'Ver en Marketplace' })).toBeInTheDocument();
  });

  it('has no «Lo usan» list when the agent is only shared with people', async () => {
    const locked: OrgNode = {
      ...agent('p2ys6ke4c7dq3hzo', 'Etiquetado', 'Auditor de etiquetas', 'platform'),
      can_use: false,
    };
    renderPage(() => Promise.resolve({ root: 'platform', nodes: [locked] }));
    await userEvent.click(await nodeButton('Etiquetado, Auditor de etiquetas'));
    const box = screen.getByRole('note');
    expect(box).toHaveTextContent('No puedes usar este agente');
    expect(box).not.toHaveTextContent('Lo usan');
  });

  it('offers "Nuevo agente" only to creators, and "Editar" with the published version', async () => {
    const first = renderPage(undefined, false);
    await nodeButton('FinOps, Analista FinOps');
    expect(screen.queryByRole('button', { name: 'Nuevo agente' })).toBeNull();
    first.unmount();

    renderPage(undefined, true);
    await userEvent.click(await nodeButton('Savings Plans, Especialista en compromisos'));
    expect(screen.getByRole('button', { name: 'Nuevo agente' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Editar' })).toHaveAttribute(
      'href',
      // With the published version: `/admin/<id>` alone needs `UseAgent` (D38).
      '/admin/k3fq7zr2m5xw6n4a/1',
    );
  });

  it('hangs agents whose supervisor is not visible from «Supervisor no visible»', async () => {
    const { container } = renderPage(() =>
      Promise.resolve({
        root: 'platform',
        nodes: [
          agent('finops', 'FinOps', 'Analista FinOps', 'platform'),
          // `null`: the supervisor is retired or the caller may not see it (D38).
          agent('k3fq7zr2m5xw6n4a', 'Savings Plans', 'Especialista en compromisos', null),
        ],
      }),
    );
    const hidden = await nodeButton(
      'Supervisor no visible, No tienes acceso a su supervisor o está retirado',
    );
    const item = hidden.closest('li') as HTMLElement;
    expect(hidden.closest('.oc-node')).toHaveClass('ghost');
    expect(
      [...item.querySelectorAll(':scope > ul > li .oc-name')].map((node) => node.textContent),
    ).toEqual(['Savings Plans']);
    // Singular: «1 subordinado».
    expect(
      screen.getByRole('button', { name: 'Ocultar 1 subordinado de Supervisor no visible' }),
    ).toBeInTheDocument();
    expect(stat('Agentes')).toBe('Agentes2');

    await userEvent.click(hidden);
    const panel = screen.getByRole('complementary', { name: 'Detalle de Supervisor no visible' });
    expect(panel).toHaveTextContent(
      'Estos agentes reportan a un supervisor que no puedes ver o que fue retirado. La línea no muestra la relación real de reporte.',
    );
    // It is not an agent: no facts and no links.
    expect(panel.querySelector('.mk-kv')).toBeNull();
    expect(within(panel).queryByRole('link')).toBeNull();
    expect(within(panel).getAllByRole('listitem')).toHaveLength(1);
    expect(container.querySelectorAll('.oc-node.ghost')).toHaveLength(1);
  });

  it('has no «Supervisor no visible» node when every supervisor is visible', async () => {
    const { container } = renderPage();
    await nodeButton('FinOps, Analista FinOps');
    expect(container.querySelector('.oc-node.ghost')).toBeNull();
    expect(screen.queryByText('Supervisor no visible')).toBeNull();
  });

  it('tells who does not get the whole tree that it is filtered (D38)', async () => {
    const subtitle = () => document.querySelector('.page-subtitle') as HTMLElement;
    const filtered = 'Ves solo los agentes que puedes usar.';
    const user = renderPage();
    await nodeButton('FinOps, Analista FinOps');
    expect(subtitle()).toHaveTextContent(filtered);
    user.unmount();

    const creator = renderPage(undefined, true);
    await nodeButton('FinOps, Analista FinOps');
    expect(subtitle()).not.toHaveTextContent(filtered);
    creator.unmount();

    renderPage(undefined, false, true);
    await nodeButton('FinOps, Analista FinOps');
    expect(subtitle()).not.toHaveTextContent(filtered);
  });

  it('folds and unfolds branches', async () => {
    renderPage();
    await nodeButton('FinOps, Analista FinOps');
    const toggle = screen.getByRole('button', { name: 'Ocultar 2 subordinados de FinOps' });
    expect(screen.queryByRole('button', { name: /1 subordinados/ })).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    const folded = screen.getByRole('button', { name: 'Mostrar 2 subordinados de FinOps' });
    expect(folded).toHaveAttribute('aria-expanded', 'false');
    expect(folded).toHaveTextContent('+2');
    expect(screen.queryByText('Savings Plans')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Expandir' }));
    expect(screen.getByText('Savings Plans')).toBeInTheDocument();
    // «Colapsar» folds the first level; the root stays open.
    await userEvent.click(screen.getByRole('button', { name: 'Colapsar' }));
    expect(screen.queryByText('Savings Plans')).toBeNull();
    expect(screen.getByText('Etiquetado')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Ocultar 4 subordinados de Platform Admin' }),
    ).toBeInTheDocument();
  });

  it('highlights the agents that match the search by name or role', async () => {
    const { container } = renderPage();
    await nodeButton('FinOps, Analista FinOps');
    const hits = () =>
      [...container.querySelectorAll('.oc-node.hit .oc-name')].map((item) => item.textContent);
    expect(hits()).toEqual([]);
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Buscar agente en el organigrama' }),
      'ANALISTA',
    );
    expect(hits()).toEqual(['FinOps', 'Anomalías']);
  });

  it('moves and zooms the chart with the keyboard', async () => {
    renderPage();
    await nodeButton('FinOps, Analista FinOps');
    const zoom = () => screen.getByTitle('Ajustar a la vista (0)').textContent;
    const fitted = transform();
    const startZoom = zoom();
    const percent = Number.parseInt(startZoom, 10);

    canvas().focus();
    expect(canvas()).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    const moved = transform();
    expect(moved).not.toBe(fitted);
    await userEvent.keyboard('{ArrowLeft}');
    expect(transform()).toBe(fitted);
    await userEvent.keyboard('{ArrowDown}{Shift>}{ArrowUp}{/Shift}');
    expect(transform()).not.toBe(fitted);

    await userEvent.keyboard('+');
    expect(zoom()).toBe(`${percent + 10}%`);
    await userEvent.keyboard('--');
    expect(zoom()).toBe(`${percent - 10}%`);
    // 0 fits the chart again.
    await userEvent.keyboard('0');
    expect(zoom()).toBe(startZoom);
    expect(transform()).toBe(fitted);
    // Browser shortcuts are left alone: +, − and 0 with ⌘, Ctrl or Alt are not intercepted.
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      for (const key of ['+', '=', '-', '0']) {
        const event = new KeyboardEvent('keydown', {
          key,
          [modifier]: true,
          bubbles: true,
          cancelable: true,
        });
        canvas().dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(zoom()).toBe(startZoom);
      }
    }
    expect(transform()).toBe(fitted);

    // The same with the buttons.
    await userEvent.click(screen.getByRole('button', { name: 'Acercar' }));
    expect(zoom()).toBe(`${percent + 10}%`);
    await userEvent.click(screen.getByRole('button', { name: 'Alejar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ajustar' }));
    expect(zoom()).toBe(startZoom);
  });

  it('lets the keyboard reach, select and fold the nodes', async () => {
    renderPage();
    await nodeButton('FinOps, Analista FinOps');
    canvas().focus();
    await userEvent.tab();
    expect(
      screen.getByRole('button', {
        name: 'Platform Admin, Raíz · no es un agente',
      }),
    ).toHaveFocus();
    await userEvent.tab();
    await userEvent.tab();
    const finops = screen.getByRole('button', { name: 'FinOps, Analista FinOps' });
    expect(finops).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(finops).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('complementary', { name: 'Detalle de FinOps' })).toBeInTheDocument();
    await userEvent.tab();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Mostrar 2 subordinados de FinOps' })).toHaveFocus();
  });

  it('shows the access notice on 403 and nothing of the tree', async () => {
    renderPage(() => Promise.reject(new ApiError(403, 'forbidden', 'forbidden')));
    expect(await screen.findByText('No tienes acceso a esta sección')).toBeInTheDocument();
    expect(screen.queryByRole('application')).toBeNull();
  });

  it('offers to retry when the chart cannot be loaded', async () => {
    let fail = true;
    const { call } = renderPage(() =>
      fail ? Promise.reject(new ApiError(500, 'internal_error', 'boom')) : Promise.resolve(ORG),
    );
    expect(await screen.findByText('No se pudo cargar el organigrama')).toBeInTheDocument();
    expect(screen.queryByText('boom')).toBeNull();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await nodeButton('FinOps, Analista FinOps')).toBeInTheDocument();
    await waitFor(() => {
      expect(call).toHaveBeenCalledTimes(2);
    });
  });
});
