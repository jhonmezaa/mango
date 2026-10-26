import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import type { Me } from '../../api/schemas';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import type { SkillsList } from './model';
import { SkillsPage } from './SkillsPage';
import { CHANGE_ID, XSS, change, detail, list, server, skill } from './testFixtures';

const CREATOR = { ...baseMe, role: null, can: { create_agent: true } };

function renderPage(call: ReturnType<typeof vi.fn>, me: Me = CREATOR) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders session={sessionValue({ api, me })}>
      <SkillsPage />
    </TestProviders>,
  );
}

/** An API whose catalog is `initial` (or the last list a decision answered). */
function apiWith(initial: SkillsList, answers: Partial<Record<string, unknown>> = {}) {
  let current = initial;
  return vi.fn((operation: string) => {
    let answer: unknown;
    if (operation === 'getSkills') answer = answers.getSkills ?? current;
    else if (operation === 'getSkillDetail') answer = answers.getSkillDetail ?? detail();
    else if (operation === 'getCatalog')
      answer = answers.getCatalog ?? {
        items: [
          server(),
          server({ id: 'aws-billing', name: 'AWS Billing', enabled: false }),
          server({ id: 'aws-pricing', name: 'AWS Pricing', data_tier: 'public' }),
        ],
        max_enabled_packs: 10,
      };
    else answer = answers[operation];
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${operation}`));
    if (answer instanceof Error) return Promise.reject(answer);
    if (operation.endsWith('SkillChange')) current = answer as SkillsList;
    return Promise.resolve(answer);
  });
}

function calls(call: ReturnType<typeof vi.fn>, operation: string) {
  return call.mock.calls.filter(([name]) => name === operation);
}

async function openDetail(name: string) {
  const user = userEvent.setup();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${escaped}`) }));
  return { user, panel: await screen.findByRole('dialog', { name }) };
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
  vi.unstubAllGlobals();
});

describe('SkillsPage', () => {
  it('lists the skills with their servers, level, agents, runs and version', async () => {
    renderPage(
      apiWith(
        list([
          skill({ pending: change() }),
          skill({
            id: 'conciliacion',
            name: 'Conciliación',
            available: false,
            runs_30d: 0,
            agents: 0,
            outdated_agents: 0,
            servers: [
              {
                id: 'aws-billing',
                name: 'AWS Billing',
                enabled: false,
                data_tier: 'account_data',
                tools: 3,
                writes: false,
              },
            ],
          }),
        ]),
      ),
    );
    const row = await screen.findByRole('button', { name: /^Revisión de costos/ });
    expect(row).toHaveTextContent('v4 en aprobación');
    expect(row).toHaveTextContent('AWS Cost Explorer');
    expect(row).toHaveTextContent('Datos de cuentas');
    expect(row).toHaveTextContent('1240');
    expect(row).toHaveTextContent('v3 · 1 en anterior');
    const off = screen.getByRole('button', { name: /^Conciliación/ });
    expect(off).toHaveClass('is-warn');
    expect(off).toHaveTextContent('Sin datos');
    expect(screen.getByRole('button', { name: /Disponibles\s*1/ })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: /Con MCP no habilitado/ }));
    expect(screen.queryByRole('button', { name: /^Revisión de costos/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Limpiar' }));
    expect(screen.getByRole('button', { name: /^Revisión de costos/ })).toBeVisible();
  });

  it('shows its own notice without access (403)', async () => {
    renderPage(apiWith(list(), { getSkills: new ApiError(403, 'forbidden', 'no') }));
    expect(await screen.findByText('No tienes acceso a Skills')).toBeVisible();
  });

  it('shows the error with a retry, and reads again', async () => {
    const call = apiWith(list(), { getSkills: new ApiError(503, 'skills_unavailable', 'x') });
    renderPage(call);
    expect(await screen.findByText('No se pudieron cargar las skills')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(calls(call, 'getSkills')).toHaveLength(2);
  });

  it('renders names and instructions as text, never as HTML', async () => {
    renderPage(
      apiWith(list([skill({ name: `Costos ${XSS}`, description: XSS })]), {
        getSkillDetail: detail({
          skill: skill({ name: `Costos ${XSS}` }),
          instructions: `${XSS}\n{{período}}`,
        }),
      }),
    );
    const { panel } = await openDetail(`Costos ${XSS}`);
    expect(await within(panel).findByText(`Costos ${XSS}`)).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
    const pre = panel.querySelector('pre.sk-ins');
    expect(pre?.textContent).toBe(`${XSS}\n{{período}}`);
    expect(pre?.querySelector('mark')?.textContent).toBe('{{período}}');
  });

  it('the detail shows agents with their version, owner and versions', async () => {
    renderPage(apiWith(list()));
    const { panel } = await openDetail('Revisión de costos');
    expect(await within(panel).findByText('Agentes que la usan · 2')).toBeVisible();
    expect(panel).toHaveTextContent('Savings Plans');
    expect(panel).toHaveTextContent('v2 · recibe v3 con su siguiente aprobación');
    expect(panel).toHaveTextContent('usuario3@example.com · propuso la v1');
    expect(panel).toHaveTextContent('v3 · aprobó usuario1@example.com');
    expect(panel).toHaveTextContent('Versiones · 3');
    expect(panel).toHaveTextContent('Variables · 1');
  });

  it('approves a new version from the detail, with its diff', async () => {
    const pending = change();
    const after = list([skill({ version: 4 })]);
    const call = apiWith(list([skill({ pending })]), {
      getSkillDetail: detail({ skill: skill({ pending }), changes: [pending] }),
      approveSkillChange: after,
    });
    renderPage(call);
    const { user, panel } = await openDetail('Revisión de costos');
    const card = await within(panel).findByRole('article');
    expect(card).toHaveTextContent('Revisión de costos · v3 → v4');
    expect(card).toHaveTextContent('2 agentes siguen en v3 hasta aprobarse');
    await user.click(within(card).getByRole('button', { name: 'Comparar con v3' }));
    const diff = card.querySelector('pre.sk-diff');
    expect(diff?.querySelector('.is-add')?.textContent).toBe('+ Paso 2 nuevo');
    expect(diff?.querySelector('.is-rem')?.textContent).toBe('- Paso 2 con {{período}}');
    expect(within(panel).getByRole('button', { name: /Nueva versión/ })).toBeDisabled();
    await user.click(within(card).getByRole('button', { name: 'Aprobar' }));
    await waitFor(() => {
      expect(calls(call, 'approveSkillChange')).toEqual([
        ['approveSkillChange', { path: { change_id: CHANGE_ID }, body: {} }],
      ]);
    });
    expect(await screen.findByText('Versión aprobada')).toBeVisible();
  });

  it('rejects with a note, and says why a decision was refused', async () => {
    const pending = change({ version: 1, skill_id: 'nueva', name: 'Nueva' });
    const call = apiWith(list([skill()], { changes: [pending] }), {
      rejectSkillChange: new ApiError(403, 'same_approver', 'x'),
    });
    renderPage(call);
    const user = userEvent.setup();
    const card = await screen.findByRole('article');
    expect(card).toHaveTextContent('Nueva skill Nueva');
    await user.click(within(card).getByRole('button', { name: 'Rechazar' }));
    const confirm = within(card).getAllByRole('button', { name: 'Rechazar' }).at(-1);
    expect(confirm).toBeDisabled();
    await user.type(within(card).getByRole('textbox', { name: 'Motivo del rechazo' }), 'No sirve');
    await user.click(
      within(card).getAllByRole('button', { name: 'Rechazar' }).at(-1) as HTMLElement,
    );
    expect(calls(call, 'rejectSkillChange')[0]?.[1]).toEqual({
      path: { change_id: CHANGE_ID },
      body: { reason: 'No sirve' },
    });
    expect(
      await screen.findByText(
        'La debe aprobar o rechazar un administrador distinto de quien la propuso.',
      ),
    ).toBeVisible();
  });

  it('whoever proposed only withdraws; without can_approve nobody else decides', async () => {
    const own = change({ version: 1, skill_id: 'mia', name: 'Mía', own: true });
    const other = change({ change_id: 'c'.repeat(32), version: 1, skill_id: 'otra', name: 'Otra' });
    renderPage(apiWith(list([skill()], { changes: [own, other], can_approve: false })));
    const cards = await screen.findAllByRole('article');
    expect(cards[0]).toHaveTextContent('Otro admin debe aprobarla');
    expect(within(cards[0] as HTMLElement).getByRole('button', { name: 'Retirar' })).toBeVisible();
    expect(within(cards[1] as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('hides «Nueva skill» to whoever cannot create agents (UX only)', async () => {
    renderPage(apiWith(list()), { ...baseMe, can: { create_agent: false } });
    await screen.findByRole('button', { name: /^Revisión de costos/ });
    expect(screen.queryByRole('button', { name: 'Nueva skill' })).toBeNull();
  });

  it('proposes a new skill and shows the limit errors of the server under the form', async () => {
    const call = apiWith(list(), {
      postSkill: new ApiError(409, 'too_many_pending', 'x'),
    });
    renderPage(call);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nueva skill' }));
    const dialog = screen.getByRole('dialog', { name: 'Nueva skill' });
    await user.click(within(dialog).getByRole('button', { name: 'Enviar a aprobación' }));
    expect(dialog).toHaveTextContent(
      'Escribe un nombre · Escribe las instrucciones · Elige al menos un MCP · Escribe el motivo',
    );
    expect(calls(call, 'postSkill')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Nombre'), 'Ahorro');
    await user.type(within(dialog).getByLabelText('Instrucciones'), 'Paso uno');
    expect(within(dialog).getByRole('button', { name: /AWS Billing/ })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: /AWS Cost Explorer/ }));
    await user.type(within(dialog).getByLabelText('Agregar entrega'), 'tabla{Enter}');
    await user.type(within(dialog).getByRole('textbox', { name: 'Motivo' }), 'Lo piden');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar a aprobación' }));
    expect(calls(call, 'postSkill')[0]?.[1]).toEqual({
      body: {
        name: 'Ahorro',
        category: 'FinOps',
        description: '',
        instructions: 'Paso uno',
        outputs: ['tabla'],
        servers: ['cost-explorer'],
        reason: 'Lo piden',
      },
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Ya hay 20 propuestas de skills abiertas, el máximo.',
    );
    expect(screen.getByRole('dialog', { name: 'Nueva skill' })).toBeVisible();
  });

  it('blocks a possible secret in the instructions before sending', async () => {
    const call = apiWith(list());
    renderPage(call);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nueva skill' }));
    const dialog = screen.getByRole('dialog', { name: 'Nueva skill' });
    await user.type(within(dialog).getByLabelText('Instrucciones'), `token = ${'A'.repeat(24)}`);
    expect(dialog).toHaveTextContent('Posible secreto en las instrucciones');
  });

  it('proposes a new version from the approved one (base_version)', async () => {
    const call = apiWith(list(), {
      postSkillVersion: { skill_id: 'revision-de-costos', change_id: CHANGE_ID },
    });
    renderPage(call);
    const { user, panel } = await openDetail('Revisión de costos');
    await user.click(await within(panel).findByRole('button', { name: /Nueva versión/ }));
    const dialog = screen.getByRole('dialog', {
      name: 'Nueva versión de Revisión de costos · v3 → v4',
    });
    expect(dialog).toHaveTextContent('hasta entonces los 2 agentes siguen con v3');
    await user.type(within(dialog).getByRole('textbox', { name: 'Motivo' }), 'Mejora');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar a aprobación' }));
    await waitFor(() => {
      expect(calls(call, 'postSkillVersion')[0]?.[1]).toMatchObject({
        path: { skill_id: 'revision-de-costos' },
        body: { base_version: 3, instructions: 'Paso 1\nPaso 2 con {{período}}\nPaso 3' },
      });
    });
    expect(await screen.findByText(/Enviada a aprobación/)).toBeVisible();
  });

  it('duplicates as instructions with the source version', async () => {
    const call = apiWith(list(), {
      postSkill: { skill_id: 'revision-de-costos-copia', change_id: CHANGE_ID },
    });
    renderPage(call);
    const { user, panel } = await openDetail('Revisión de costos');
    await user.click(await within(panel).findByRole('button', { name: /Duplicar/ }));
    await waitFor(() => {
      expect(calls(call, 'postSkill')[0]?.[1]).toMatchObject({
        body: {
          name: 'Revisión de costos (copia)',
          duplicate_of: 'revision-de-costos@3',
          reason: 'Duplicada desde Revisión de costos v3',
        },
      });
    });
    expect(await screen.findByText(/Copia enviada a aprobación/)).toBeVisible();
  });
});
