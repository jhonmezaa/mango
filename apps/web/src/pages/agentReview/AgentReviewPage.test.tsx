import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { AgentReviewPage } from './AgentReviewPage';
import type { Review, Reviews, Version } from './reviewModel';

const ME = { ...baseMe, user_id: 'admin-1', email: 'admin1@empresa.com', is_admin: true };
const HASH = 'c'.repeat(64);
const CHANGE = 'k3fq7zr2m5xw6n4a';
const NEW = 'b6t2hd5yq7lc3vpe';

function review(overrides: Partial<Review> = {}): Review {
  return {
    agent_id: CHANGE,
    version: 3,
    status: 'in_review',
    kind: 'change',
    name: 'Savings Plans',
    description: 'Revisa la cobertura de Savings Plans y sugiere compras.',
    category: 'Finanzas',
    icon: 'Zap',
    color: 4,
    content_hash: HASH,
    created_by: 'admin-2',
    created_by_email: 'admin2@empresa.com',
    submitted_at: new Date(Date.now() - 3_600_000).toISOString(),
    approved_by: null,
    approved_by_email: null,
    approved_at: null,
    published_at: null,
    failed_step: null,
    rejected_by: null,
    rejected_by_email: null,
    rejected_at: null,
    rejection_reason: null,
    retired_by: null,
    retired_by_email: null,
    retired_at: null,
    retire_reason: null,
    decided_at: null,
    retryable: false,
    changes: 7,
    is_author: false,
    ...overrides,
  };
}

const DEFINITION: Version['definition'] = {
  name: 'Savings Plans',
  description: 'Revisa la cobertura de Savings Plans y sugiere compras.',
  category: 'Finanzas',
  icon: 'Zap',
  color: 4,
  reports_to: 'finops',
  role: 'Especialista en compromisos',
  model: 'mock.model-v1',
  allowed_models: ['mock.model-v1'],
  system_prompt: 'You review Savings Plans coverage.\nAlways state the period.',
  tools: ['cost-explorer.get_cost_forecast', 'pack.stop_instances'],
  approval_tools: ['pack.stop_instances'],
  limits: {
    max_tokens: 4096,
    max_iterations: 12,
    timeout_seconds: 120,
    max_tokens_per_call: null,
    temperature: null,
  },
  groups: ['bu-retail', 'finops-central'],
  users: [],
};

/** A change to a published agent: every kind of difference the backend reports. */
function version(overrides: Partial<Version> = {}): Version {
  return {
    agent_id: CHANGE,
    version: 3,
    status: 'in_review',
    revision: 2,
    content_hash: HASH,
    base_version: 2,
    created_by: 'admin-2',
    created_by_email: 'admin2@empresa.com',
    created_at: new Date(Date.now() - 7_200_000).toISOString(),
    updated_at: new Date(Date.now() - 3_600_000).toISOString(),
    submitted_by: 'admin-2',
    submitted_at: new Date(Date.now() - 3_600_000).toISOString(),
    approved_by: null,
    approved_by_email: null,
    approved_at: null,
    rejected_by: null,
    rejected_by_email: null,
    rejected_at: null,
    rejection_reason: null,
    failed_step: null,
    failure: null,
    published_at: null,
    is_author: false,
    agent: {
      status: 'published',
      lock_version: 1,
      published_version: 2,
      open_version: 3,
      created_by: 'admin-2',
    },
    definition: DEFINITION,
    base: null,
    diff: {
      is_new: false,
      changes: 7,
      fields: [
        { field: 'reports_to', before: 'platform', after: 'finops' },
        { field: 'limits.max_iterations', before: 8, after: 12 },
      ],
      sets: [
        {
          field: 'tools',
          added: ['pack.stop_instances'],
          removed: ['cost-explorer.get_cost_and_usage'],
        },
        { field: 'approval_tools', added: ['pack.stop_instances'], removed: [] },
        { field: 'groups', added: ['bu-retail'], removed: ['bu-finanzas'] },
      ],
      prompt: [
        { op: ' ', text: 'You review Savings Plans coverage.' },
        { op: '-', text: 'Answer in Spanish.' },
        { op: '+', text: 'Always state the period.' },
      ],
    },
    violations: [],
    ...overrides,
  };
}

const CATALOG = {
  items: [
    {
      id: 'cost-explorer',
      kind: 'connector',
      name: 'AWS Cost Explorer',
      description: '',
      provider: 'Mango',
      data_tier: 'account_data',
      identity_mode: 'per_user',
      enabled: true,
      permissions: [],
      tools: ['get_cost_and_usage', 'get_cost_forecast'].map((name) => ({
        ref: `cost-explorer.${name}`,
        name,
        description: '',
        access: 'read',
        audience: 'all',
        central_groups_only: false,
      })),
    },
    {
      id: 'pack',
      kind: 'pack',
      name: 'Pack',
      description: '',
      provider: 'AWS Labs',
      data_tier: 'write',
      identity_mode: 'service',
      enabled: false,
      permissions: [],
      tools: [
        {
          ref: 'pack.stop_instances',
          name: 'stop_instances',
          description: '',
          access: 'write',
          audience: 'central',
          central_groups_only: true,
        },
      ],
    },
  ],
};
const GROUPS = {
  items: [
    { id: 'bu-retail', type: 'area', area: 'retail', description: '' },
    { id: 'finops-central', type: 'central', area: null, description: '' },
  ],
};
const ORG = {
  root: 'platform',
  nodes: [
    {
      id: 'finops',
      name: 'FinOps',
      role: '',
      description: '',
      category: '',
      icon: 'Money',
      color: 2,
      reports_to: 'platform',
    },
  ],
};

type Handlers = Partial<Record<string, (input: unknown) => Promise<unknown>>>;

function setup(reviews: Reviews, handlers: Handlers = {}, me = ME, path = '/review') {
  const routes: Handlers = {
    getReviews: () => Promise.resolve(reviews),
    readVersion: () => Promise.resolve(version()),
    getCatalog: () => Promise.resolve(CATALOG),
    listGroups: () => Promise.resolve(GROUPS),
    getOrg: () => Promise.resolve(ORG),
    ...handlers,
  };
  const call = vi.fn((id: string, input?: unknown) => {
    const route = routes[id];
    return route ? route(input) : Promise.reject(new ApiError(404, 'not_found', id));
  });
  const view = render(
    <TestProviders
      session={sessionValue({ api: { call } as unknown as ApiClient, me })}
      path={path}
    >
      <Routes>
        <Route path="review/*" element={<AgentReviewPage />} />
      </Routes>
    </TestProviders>,
  );
  const calls = (id: string) => call.mock.calls.filter(([name]) => name === id);
  return { call, calls, user: userEvent.setup(), ...view };
}

const detail = () => screen.findByRole('region', { name: 'Detalle de la revisión' });

/** A screen of 760 px or less (design: the queue takes the whole width). */
function narrowScreen() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 760px)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentReviewPage (design agent-review.jsx)', () => {
  it('opens the first version of the queue with the diff the backend computed', async () => {
    const { calls } = setup({
      queue: [review(), review({ agent_id: NEW, version: 1 })],
      history: [],
    });
    const panel = await detail();
    await within(panel).findByRole('heading', { level: 2, name: 'Savings Plans' });
    expect(calls('readVersion')[0]?.[1]).toEqual({ path: { agent_id: CHANGE, version: 3 } });
    expect(screen.getByRole('tab', { name: /En revisión/ })).toHaveTextContent('2');
    expect(within(panel).getByText(`${CHANGE} · v3`)).toBeInTheDocument();
    expect(within(panel).getByText('Cambio a publicado')).toBeInTheDocument();
    expect(panel).toHaveTextContent('Hecho por admin2@empresa.com');
    expect(panel).toHaveTextContent('lo publicado sigue activo mientras tanto');

    // Organization: the supervisor by name, old → new.
    const reports = within(panel).getByText('Reporta a').parentElement as HTMLElement;
    expect(reports).toHaveTextContent('Platform Admin → FinOps');

    // Prompt by lines.
    const prompt = within(panel).getByRole('group', { name: 'system prompt' });
    expect(within(prompt).getByText('Always state the period.').closest('div')).toHaveClass('add');
    expect(within(prompt).getByText('Answer in Spanish.').closest('div')).toHaveClass('rem');
    expect(within(panel).getByText('system prompt · modificado')).toBeInTheDocument();

    // Tools: added and removed, with what the catalog says about each.
    expect(within(panel).getByText('tools · 1 agregadas, 1 quitadas')).toBeInTheDocument();
    const added = within(panel)
      .getAllByText('pack.stop_instances')
      .map((node) => node.closest('.rv-tool'))
      .find(Boolean) as HTMLElement;
    expect(added).toHaveClass('add');
    expect(added).toHaveTextContent('Escritura · confirmación o aprobación en cada uso');
    expect(added).toHaveTextContent('No habilitada');
    const removed = within(panel)
      .getByText('cost-explorer.get_cost_and_usage')
      .closest('.rv-tool') as HTMLElement;
    expect(removed).toHaveClass('rem');
    expect(removed).toHaveTextContent('Datos de cuentas');
    expect(removed).toHaveTextContent('Lectura');
    expect(removed).not.toHaveTextContent('No habilitada');

    // The tool that now asks for approval, in its own block.
    const approval = within(panel).getByText('Aprobación en cada uso').parentElement as HTMLElement;
    expect(within(approval).getByText('pack.stop_instances').closest('li')).toHaveClass('add');
    expect(approval).toHaveTextContent('Pide aprobación');

    // Access: the added group is marked with its type, the removed one is struck.
    const groups = within(panel)
      .getByRole('heading', { name: 'acceso' })
      .closest('section') as HTMLElement;
    expect(within(groups).getByText('Grupos')).toBeInTheDocument();
    expect(within(groups).queryByText('Usuarios')).toBeNull();
    expect(within(groups).getByText('bu-retail', { exact: false }).closest('li')).toHaveClass(
      'add',
    );
    expect(groups).toHaveTextContent('área');
    expect(within(groups).getByText('bu-finanzas', { exact: false }).closest('li')).toHaveClass(
      'rem',
    );

    // Limits: old → new only where it changed.
    const iterations = within(panel).getByText('Iteraciones').parentElement as HTMLElement;
    expect(iterations).toHaveTextContent('8 → 12');
    expect(within(panel).getByText('Tokens por respuesta').parentElement).toHaveTextContent('4096');
    // Always listed, even when the version does not set them.
    expect(within(panel).getByText('Tokens por llamada').parentElement).toHaveTextContent('—');
    expect(within(panel).getByText('Temperatura').parentElement).toHaveTextContent('—');
    expect(within(panel).queryByText(/Presupuesto/)).toBeNull();
    expect(within(panel).queryByText(/otros cambios/)).toBeNull();
    expect(within(panel).getByText('Apruebas como admin1@empresa.com')).toBeInTheDocument();
  });

  it('shows a new agent whole, and its creator text as text', async () => {
    const hostile = version({
      agent_id: NEW,
      version: 1,
      base_version: null,
      definition: {
        ...DEFINITION,
        name: 'Anomalías <b>Retail</b>',
        description: 'Explica anomalías. <script>alert(1)</script>',
        tools: ['cost-explorer.get_cost_forecast'],
        approval_tools: [],
      },
      diff: {
        is_new: true,
        changes: 3,
        fields: [],
        sets: [
          { field: 'tools', added: ['cost-explorer.get_cost_forecast'], removed: [] },
          { field: 'groups', added: ['bu-retail', 'finops-central'], removed: [] },
        ],
        prompt: [{ op: '+', text: '<img src=x onerror=alert(1)>' }],
      },
    });
    const { container } = setup(
      {
        queue: [
          review({ agent_id: NEW, version: 1, kind: 'new', name: 'Anomalías <b>Retail</b>' }),
        ],
        history: [],
      },
      { readVersion: () => Promise.resolve(hostile) },
    );
    const panel = await detail();
    expect(
      await within(panel).findByRole('heading', { level: 2, name: 'Anomalías <b>Retail</b>' }),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent('Explica anomalías. <script>alert(1)</script>');
    expect(within(panel).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('script, img')).toBeNull();
    expect(within(screen.getByRole('listbox')).getByText('Agente nuevo')).toBeInTheDocument();
    expect(within(panel).getByText('Categoría').parentElement).toHaveTextContent('Finanzas');
    expect(within(panel).getByText('tools · 1')).toBeInTheDocument();
    expect(panel).not.toHaveTextContent('lo publicado sigue activo');
  });

  it('does not let the creator decide, and never calls the API for it', async () => {
    const { calls, user } = setup(
      { queue: [review({ is_author: true })], history: [] },
      { readVersion: () => Promise.resolve(version({ is_author: true })) },
    );
    const approve = await screen.findByRole('button', { name: 'Aprobar y publicar' });
    expect(approve).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rechazar' })).toBeDisabled();
    expect(
      screen.getByText('Lo hiciste tú: lo debe aprobar otro administrador.'),
    ).toBeInTheDocument();
    expect(within(screen.getByRole('listbox')).getByText('Tuyo')).toBeInTheDocument();
    await user.click(approve);
    expect(calls('approveVersion')).toHaveLength(0);
  });

  it('shows the refusal of the API when it is the one that knows the approver wrote it', async () => {
    const { calls, user } = setup(
      { queue: [review()], history: [] },
      { approveVersion: () => Promise.reject(new ApiError(403, 'same_approver', 'raw message')) },
    );
    await user.click(await screen.findByRole('button', { name: 'Aprobar y publicar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No puedes aprobar una versión que enviaste tú. La debe aprobar otro administrador.',
    );
    expect(screen.queryByText('raw message')).toBeNull();
    expect(calls('approveVersion')).toHaveLength(1);
  });

  it('approves with the hash that was read and reloads the lists', async () => {
    const approved = version({ status: 'approved', approved_by: 'admin-1' });
    const { calls, user } = setup(
      { queue: [review()], history: [] },
      { approveVersion: () => Promise.resolve(approved) },
    );
    await user.click(await screen.findByRole('button', { name: 'Aprobar y publicar' }));
    expect(await screen.findByText('Aprobado · publicando Savings Plans')).toBeInTheDocument();
    expect(calls('approveVersion')[0]?.[1]).toEqual({
      path: { agent_id: CHANGE, version: 3 },
      body: { content_hash: HASH },
    });
    expect(
      await screen.findByText('Aprobado por admin1@empresa.com. Publicando…'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aprobar y publicar' })).toBeNull();
    await waitFor(() => {
      expect(calls('getReviews')).toHaveLength(2);
    });
  });

  it('does not reject without a reason', async () => {
    const { calls, user } = setup(
      { queue: [review()], history: [] },
      { rejectVersion: () => Promise.resolve(version({ status: 'draft' })) },
    );
    await user.click(await screen.findByRole('button', { name: 'Rechazar' }));
    const reason = screen.getByLabelText('Motivo del rechazo');
    expect(reason).toHaveFocus();
    await user.type(reason, '   ');
    await user.click(screen.getByRole('button', { name: 'Confirmar rechazo' }));
    expect(screen.getByText('El motivo es obligatorio')).toBeInTheDocument();
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(calls('rejectVersion')).toHaveLength(0);

    await user.clear(reason);
    await user.type(reason, '  Falta el periodo.  ');
    await user.click(screen.getByRole('button', { name: 'Confirmar rechazo' }));
    expect(await screen.findByText('Savings Plans rechazado')).toBeInTheDocument();
    expect(calls('rejectVersion')[0]?.[1]).toEqual({
      path: { agent_id: CHANGE, version: 3 },
      body: { reason: 'Falta el periodo.' },
    });
  });

  it('blocks the approval of a version that breaks the rules and offers them as the reason', async () => {
    const { calls, user } = setup(
      { queue: [review()], history: [] },
      {
        readVersion: () =>
          Promise.resolve(
            version({
              violations: [
                { code: 'tool_not_enabled', field: 'tools', items: ['pack.stop_instances'] },
                { code: 'rule_from_the_future', field: 'x', items: [] },
              ],
            }),
          ),
      },
    );
    const panel = await detail();
    expect(
      await within(panel).findByText('No cumple las reglas de publicación'),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent('Hay tools que no están habilitadas: pack.stop_instances.');
    expect(panel).toHaveTextContent('Incumple una regla de publicación (rule_from_the_future).');
    const approve = screen.getByRole('button', { name: 'Aprobar y publicar' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', 'Corrige los problemas antes de aprobar');
    await user.click(approve);
    expect(calls('approveVersion')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Rechazar' }));
    await user.click(
      screen.getByRole('button', {
        name: 'Usar: Hay tools que no están habilitadas: pack',
      }),
    );
    expect(screen.getByLabelText('Motivo del rechazo')).toHaveValue(
      'Hay tools que no están habilitadas: pack.stop_instances. Hay que quitarlas o pedir que se habilite su MCP.',
    );
  });

  it('reads again a version that changed while it was being reviewed', async () => {
    const { calls, user } = setup(
      { queue: [review()], history: [] },
      { approveVersion: () => Promise.reject(new ApiError(409, 'version_conflict', 'x')) },
    );
    await user.click(await screen.findByRole('button', { name: 'Aprobar y publicar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La versión cambió mientras la revisabas. Vuelve a cargarla para ver lo que se envió.',
    );
    await waitFor(() => {
      expect(calls('readVersion')).toHaveLength(2);
    });
    // Still in review: the decision stays available on what was read again.
    expect(screen.getByRole('button', { name: 'Aprobar y publicar' })).toBeEnabled();
  });

  it('says so when the version is no longer in review, and refreshes the queue on request', async () => {
    let decided = false;
    const { calls, user } = setup(
      { queue: [review()], history: [] },
      {
        readVersion: () => Promise.resolve(version(decided ? { status: 'draft' } : {})),
        approveVersion: () => {
          decided = true;
          return Promise.reject(new ApiError(409, 'version_conflict', 'x'));
        },
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Aprobar y publicar' }));
    const panel = await detail();
    expect(
      await within(panel).findByText('Esta versión ya no está en revisión'),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent('otro administrador ya la decidió');
    expect(screen.queryByRole('button', { name: 'Aprobar y publicar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rechazar' })).toBeNull();
    expect(calls('getReviews')).toHaveLength(1);
    await user.click(within(panel).getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => {
      expect(calls('getReviews')).toHaveLength(2);
    });
  });

  it('treats a version that no longer exists as one that left the review', async () => {
    setup(
      { queue: [review()], history: [] },
      { readVersion: () => Promise.reject(new ApiError(404, 'not_found', 'x')) },
    );
    expect(await screen.findByText('Esta versión ya no está en revisión')).toBeInTheDocument();
  });

  it('does not let a version be approved while its rules cannot be evaluated', async () => {
    let known = false;
    const { calls, user } = setup(
      { queue: [review()], history: [] },
      {
        readVersion: () => Promise.resolve(version(known ? {} : { violations: null })),
      },
    );
    const panel = await detail();
    expect(
      await within(panel).findByText('No se pudieron evaluar las reglas de publicación'),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent('No sabemos si esta versión las cumple.');
    const approve = screen.getByRole('button', { name: 'Aprobar y publicar' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', 'Las reglas no se pudieron evaluar');
    expect(panel).toHaveTextContent('No se puede aprobar hasta que se evalúen las reglas.');
    await user.click(approve);
    expect(calls('approveVersion')).toHaveLength(0);

    known = true;
    await user.click(screen.getByRole('button', { name: 'Volver a evaluar' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Aprobar y publicar' })).toBeEnabled();
    });
    expect(calls('readVersion')).toHaveLength(2);
  });

  it('keeps the notice of an approval whose publication did not start', async () => {
    const { calls, user } = setup(
      { queue: [review()], history: [] },
      {
        approveVersion: () =>
          Promise.resolve(version({ status: 'failed', failed_step: 'start_publication' })),
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Aprobar y publicar' }));
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('Aprobación registrada · la publicación no arrancó');
    expect(notice).toHaveTextContent('podrás reintentarla desde el Historial pasados 45 minutos.');
    expect(screen.queryByRole('button', { name: 'Aprobar y publicar' })).toBeNull();
    // The notice stays: the queue is not read again behind it.
    expect(calls('getReviews')).toHaveLength(1);
    expect(calls('approveVersion')).toHaveLength(1);
  });

  it.each([
    ['provisioner_unavailable', 503, 'El servicio de publicación no está disponible.'],
    ['audit_unavailable', 503, 'No se pudo registrar la decisión en Auditoría'],
    ['models_unavailable', 503, 'No se puede aprobar hasta que se evalúen.'],
    ['validation_failed', 422, 'Revisa los problemas de arriba.'],
  ])('explains %s in the foot, with its own text', async (code, status, text) => {
    const { user } = setup(
      { queue: [review()], history: [] },
      { approveVersion: () => Promise.reject(new ApiError(status, code, 'raw server text')) },
    );
    await user.click(await screen.findByRole('button', { name: 'Aprobar y publicar' }));
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent(text);
    expect(error.closest('.ap-detail-f')).not.toBeNull();
    expect(screen.queryByText('raw server text')).toBeNull();
  });

  it('shows the people of the version by email when the directory knows them', async () => {
    const shared = version({
      definition: { ...DEFINITION, users: ['user-8', 'user-9'] },
      diff: {
        is_new: false,
        changes: 2,
        fields: [],
        sets: [{ field: 'users', added: ['user-8'], removed: ['user-3'] }],
        prompt: null,
      },
    });
    const resolveUsers = vi.fn(() =>
      Promise.resolve({
        users: [
          { id: 'user-8', email: 'ana@empresa.com' },
          { id: 'user-3', email: '<b>luis</b>@empresa.com' },
        ],
        emails_not_found: [],
        ids_not_found: ['user-9'],
      }),
    );
    setup(
      { queue: [review()], history: [] },
      { readVersion: () => Promise.resolve(shared), resolveUsers },
    );
    const panel = await detail();
    const access = (await within(panel).findByRole('heading', { name: 'acceso' }))
      .parentElement as HTMLElement;
    const added = (await within(access).findByText('ana@empresa.com', { exact: false })).closest(
      'li',
    );
    expect(added).toHaveClass('add');
    expect(added).not.toHaveClass('mono');
    // Directory text is rendered as text; an identifier without an email stays as it is.
    expect(
      within(access).getByText('<b>luis</b>@empresa.com', { exact: false }).closest('li'),
    ).toHaveClass('rem');
    expect(within(access).getByText('user-9').closest('li')).toHaveClass('mono');
    expect(within(access).queryByText('user-8', { exact: false })).toBeNull();
    expect(resolveUsers).toHaveBeenCalledExactlyOnceWith({
      body: { ids: ['user-3', 'user-8', 'user-9'] },
    });
  });

  it('shows every kind of change, and lists the ones it has no section for', async () => {
    const full = version({
      definition: {
        ...DEFINITION,
        users: ['user-8'],
        limits: { ...DEFINITION.limits, max_tokens_per_call: 2048, temperature: 0.3 },
      },
      diff: {
        is_new: false,
        changes: 9,
        fields: [
          { field: 'category', before: 'FinOps', after: 'Finanzas' },
          { field: 'icon', before: 'Bot', after: 'Zap' },
          { field: 'color', before: 1, after: 4 },
          { field: 'limits.max_tokens_per_call', before: null, after: 2048 },
          { field: 'limits.temperature', before: 0.2, after: 0.3 },
          { field: 'memory', before: null, after: 'session' },
        ],
        sets: [
          { field: 'allowed_models', added: ['mock.model-v2'], removed: ['mock.model-v0'] },
          { field: 'approval_tools', added: [], removed: ['cost-explorer.get_cost_forecast'] },
          { field: 'users', added: ['user-8'], removed: ['user-3'] },
        ],
        prompt: null,
      },
    });
    setup({ queue: [review()], history: [] }, { readVersion: () => Promise.resolve(full) });
    const panel = await detail();
    await within(panel).findByRole('heading', { level: 2, name: 'Savings Plans' });
    expect(within(panel).getByText('Categoría').parentElement).toHaveTextContent(
      'FinOps → Finanzas',
    );
    expect(within(panel).getByText('Ícono').parentElement).toHaveTextContent('Bot → Zap');
    expect(within(panel).getByText('Color').parentElement).toHaveTextContent('1 → 4');
    const models = within(panel).getByText('Modelos permitidos').parentElement as HTMLElement;
    expect(within(models).getByText('mock.model-v2', { exact: false })).toHaveClass('add');
    expect(within(models).getByText('mock.model-v0', { exact: false })).toHaveClass('rem');
    expect(within(panel).getByText('Ya no pide aprobación').closest('li')).toHaveClass('rem');
    const access = within(panel).getByRole('heading', { name: 'acceso' })
      .parentElement as HTMLElement;
    expect(within(access).getByText('Usuarios')).toBeInTheDocument();
    expect(within(access).getByText('user-8', { exact: false }).closest('li')).toHaveClass('add');
    expect(within(access).getByText('user-3', { exact: false }).closest('li')).toHaveClass('rem');
    expect(within(panel).getByText('Tokens por llamada').parentElement).toHaveTextContent(
      '— → 2048',
    );
    expect(within(panel).getByText('Temperatura').parentElement).toHaveTextContent('0.2 → 0.3');
    const other = within(panel).getByRole('heading', { name: 'otros cambios · 1' })
      .parentElement as HTMLElement;
    expect(other).toHaveTextContent('Campos sin sección propia. Revísalos antes de aprobar.');
    expect(other).toHaveTextContent('memory');
    expect(other).toHaveTextContent('— → session');
  });

  it('gives the whole width to the queue under 760 px and opens the detail over it', async () => {
    narrowScreen();
    const { user } = setup({
      queue: [review(), review({ agent_id: NEW, version: 1, name: 'Anomalías' })],
      history: [],
    });
    const queue = await screen.findByRole('listbox', { name: 'Agentes en revisión' });
    expect(within(queue).getAllByRole('option')).toHaveLength(2);
    expect(screen.queryByRole('region', { name: 'Detalle de la revisión' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Revisión de agentes' })).toBeVisible();

    await user.click(within(queue).getByRole('option', { name: /Savings Plans/ }));
    const panel = await detail();
    await within(panel).findByRole('heading', { level: 2, name: 'Savings Plans' });
    expect(queue.closest('.ap-body')).toHaveClass('show-detail');
    // The title and the tabs give their place to the detail and its fixed foot.
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Aprobar y publicar' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Volver a la cola' }));
    expect(screen.queryByRole('region', { name: 'Detalle de la revisión' })).toBeNull();
    expect(screen.getByRole('tab', { name: /En revisión/ })).toBeInTheDocument();
  });

  it('keeps a version that is being published in the queue', async () => {
    setup(
      {
        queue: [],
        history: [review({ status: 'approved', approved_by: 'admin-9', changes: null })],
      },
      {
        readVersion: () => Promise.resolve(version({ status: 'approved', approved_by: 'admin-9' })),
      },
    );
    const queue = await screen.findByRole('listbox', { name: 'Agentes en revisión' });
    expect(within(queue).getByText('Publicando…')).toBeInTheDocument();
    expect(await screen.findByText('Aprobado por admin-9. Publicando…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aprobar y publicar' })).toBeNull();
  });

  it('opens the version of a deep link', async () => {
    const { calls } = setup(
      {
        queue: [review(), review({ agent_id: NEW, version: 1, kind: 'new', name: 'Otro' })],
        history: [],
      },
      {},
      ME,
      `/review/${NEW}/1`,
    );
    await detail();
    expect(screen.getByRole('option', { name: /Otro/ })).toHaveAttribute('aria-selected', 'true');
    expect(calls('readVersion')[0]?.[1]).toEqual({ path: { agent_id: NEW, version: 1 } });
  });

  it('says so when there is nothing to review', async () => {
    setup({ queue: [], history: [] });
    expect(await screen.findByText('Nada por revisar')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'En revisión' })).toBeInTheDocument();
  });

  it('lists the history and retries a failed publication with its hash', async () => {
    const failed = review({
      agent_id: 'p2ys6ke4c7dq3hzo',
      version: 1,
      status: 'failed',
      kind: 'new',
      name: 'Etiquetado',
      approved_by: 'admin-1',
      failed_step: 'create_harness',
      retryable: true,
      changes: null,
    });
    const published = review({
      agent_id: 'finops',
      version: 1,
      status: 'published',
      kind: 'new',
      name: 'FinOps',
      created_by: 'release',
      created_by_email: null,
      approved_by: 'release@0.1.0',
      changes: null,
    });
    const { calls, user } = setup(
      { queue: [], history: [failed, published] },
      { retryVersion: () => Promise.resolve(version({ status: 'approved' })) },
    );
    await screen.findByText('Nada por revisar');
    await user.click(screen.getByRole('tab', { name: 'Historial' }));
    const rows = within(
      screen.getByRole('table', { name: 'Historial de revisiones' }),
    ).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Etiquetado');
    expect(rows[1]).toHaveTextContent('Fallido');
    expect(rows[1]).toHaveTextContent('Falló en «create_harness»');
    // The reviewer is the caller: shown by email. A decision with no email on record shows
    // the internal identifier, and says so.
    expect(rows[1]).toHaveTextContent('admin1@empresa.com');
    expect(rows[2]).toHaveTextContent('release@0.1.0');
    const legacy = within(rows[2] as HTMLElement).getByText('release@0.1.0');
    expect(legacy).toHaveClass('mono');
    expect(legacy).toHaveAttribute(
      'title',
      'Decisión anterior al registro de correos: se muestra el identificador interno',
    );
    // Stacked rows (≤760 px) name the two people of each row.
    expect(legacy).toHaveAttribute('data-label', 'Revisado por');
    expect(within(rows[1] as HTMLElement).getByText('admin1@empresa.com')).not.toHaveClass('mono');
    expect(screen.getByRole('table', { name: 'Historial de revisiones' })).toHaveClass('rh-table');
    expect(rows[2]).toHaveTextContent('Publicado');

    await user.type(screen.getByRole('searchbox', { name: 'Buscar en el historial' }), 'etiq');
    expect(screen.queryByText('FinOps')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reintentar: Etiquetado' }));
    expect(await screen.findByText('Reintentando publicación')).toBeInTheDocument();
    expect(calls('retryVersion')[0]?.[1]).toEqual({
      path: { agent_id: 'p2ys6ke4c7dq3hzo', version: 1 },
      body: { content_hash: HASH },
    });
    await user.clear(screen.getByRole('searchbox', { name: 'Buscar en el historial' }));
    await user.type(screen.getByRole('searchbox', { name: 'Buscar en el historial' }), 'zzz');
    expect(screen.getByText('Sin resultados.')).toBeInTheDocument();
  });

  it('shows rejected and retired versions with who decided and why, as text', async () => {
    const rejected = review({
      agent_id: 'p2ys6ke4c7dq3hzo',
      version: 2,
      status: 'draft',
      name: 'Etiquetado',
      content_hash: null,
      rejected_by: 'admin-9',
      rejected_by_email: 'revisora@empresa.com',
      rejected_at: new Date(Date.now() - 60_000).toISOString(),
      rejection_reason: 'Falta el <b>alcance</b>',
      changes: 1,
    });
    const retired = review({
      agent_id: 'x7mq2nd4w6yt5rka',
      version: 4,
      status: 'retired',
      name: 'Inventario',
      approved_by: 'admin-3',
      retired_by: 'admin-1',
      retired_by_email: null,
      retire_reason: 'Duplicado de FinOps',
      changes: 3,
    });
    const { user } = setup({ queue: [], history: [rejected, retired] });
    await screen.findByText('Nada por revisar');
    await user.click(screen.getByRole('tab', { name: 'Historial' }));
    const table = screen.getByRole('table', { name: 'Historial de revisiones' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Rechazado');
    expect(rows[1]).toHaveTextContent('revisora@empresa.com');
    expect(rows[1]).toHaveTextContent('“Falta el <b>alcance</b>”');
    expect(rows[1]).toHaveTextContent('1 cambio');
    expect(rows[2]).toHaveTextContent('Retirado');
    // Who retired it is the caller: shown by email, not by the approver of the version.
    expect(rows[2]).toHaveTextContent('admin1@empresa.com');
    expect(rows[2]).toHaveTextContent('Retirado · “Duplicado de FinOps”');
    expect(rows[2]).toHaveTextContent('3 cambios');
    expect(table.querySelector('b')).toBeNull();
    expect(within(table).queryByRole('button', { name: /Reintentar/ })).toBeNull();

    // The reviewer can be searched by the email the API gave.
    await user.type(screen.getByRole('searchbox', { name: 'Buscar en el historial' }), 'revisora');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
  });

  it('offers to retry an approval nothing is publishing any more', async () => {
    const stuck = review({
      agent_id: 'p2ys6ke4c7dq3hzo',
      version: 1,
      status: 'approved',
      kind: 'new',
      name: 'Etiquetado',
      approved_by: 'admin-2',
      retryable: true,
    });
    const publishing = review({
      agent_id: 'x7mq2nd4w6yt5rka',
      version: 1,
      status: 'approved',
      kind: 'new',
      name: 'Inventario',
      approved_by: 'admin-2',
    });
    const { calls, user } = setup(
      { queue: [], history: [stuck, publishing] },
      { retryVersion: () => Promise.resolve(version({ status: 'approved' })) },
    );
    // Only the one still being published stays in the queue.
    const queue = await screen.findByRole('listbox', { name: 'Agentes en revisión' });
    expect(within(queue).getAllByRole('option')).toHaveLength(1);
    expect(queue).toHaveTextContent('Inventario');
    expect(queue).toHaveTextContent('Publicando…');

    await user.click(screen.getByRole('tab', { name: 'Historial' }));
    const rows = within(
      screen.getByRole('table', { name: 'Historial de revisiones' }),
    ).getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('Fallido');
    expect(rows[1]).toHaveTextContent('Falló en «publication_expired»');
    await user.click(screen.getByRole('button', { name: 'Reintentar: Etiquetado' }));
    expect(calls('retryVersion')[0]?.[1]).toEqual({
      path: { agent_id: 'p2ys6ke4c7dq3hzo', version: 1 },
      body: { content_hash: HASH },
    });
  });

  it('still shows the diff when names and labels cannot be loaded', async () => {
    const unavailable = () => Promise.reject(new ApiError(404, 'not_found', 'x'));
    setup(
      { queue: [review()], history: [] },
      { getCatalog: unavailable, listGroups: unavailable, getOrg: unavailable },
    );
    const panel = await detail();
    expect(await within(panel).findByText('Reporta a')).toBeInTheDocument();
    expect(within(panel).getByText('Reporta a').parentElement).toHaveTextContent(
      'Platform Admin → finops',
    );
    const tool = within(panel)
      .getByText('cost-explorer.get_cost_and_usage')
      .closest('.rv-tool') as HTMLElement;
    // Nothing is claimed about a tool without the catalog.
    expect(tool.querySelector('.badge')).toBeNull();
  });

  it('is only for admins: no call without the flag, and the 403 of the API closes it', async () => {
    const first = setup({ queue: [review()], history: [] }, {}, { ...ME, is_admin: false });
    expect(screen.getByRole('status')).toHaveTextContent('No tienes acceso a esta sección');
    expect(
      screen.getByText('Revisar agentes es solo para administradores de Mango.'),
    ).toBeInTheDocument();
    expect(first.call).not.toHaveBeenCalled();
    first.unmount();

    setup(
      { queue: [], history: [] },
      { getReviews: () => Promise.reject(new ApiError(403, 'forbidden', 'x')) },
    );
    expect(await screen.findByText('No tienes acceso a esta sección')).toBeInTheDocument();
  });

  it('offers to retry when the lists cannot be loaded', async () => {
    let fail = true;
    const { user } = setup(
      { queue: [], history: [] },
      {
        getReviews: () => {
          if (!fail) return Promise.resolve({ queue: [], history: [] });
          fail = false;
          return Promise.reject(new ApiError(503, 'http_503', 'x'));
        },
      },
    );
    // While it loads: placeholders, announced as a status.
    expect(screen.getByRole('status', { name: 'Cargando revisiones' })).toBeInTheDocument();
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('No se pudieron cargar las revisiones');
    expect(error).toHaveTextContent('No se pudo completar la acción. Inténtalo de nuevo.');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Nada por revisar')).toBeInTheDocument();
  });
});
