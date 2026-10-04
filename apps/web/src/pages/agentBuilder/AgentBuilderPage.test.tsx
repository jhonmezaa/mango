import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { budgetsFixture } from '../../test/adminFixtures';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { AgentBuilderPage } from './AgentBuilderPage';
import type { Version } from './model';
import { AGENT_ID, context, definition, orgNodes, quotas, version } from './testFixtures';

type Handler = (input: {
  path?: Record<string, unknown>;
  body?: Record<string, unknown>;
}) => unknown;

const published = (id: string, overrides: Partial<Version> = {}) =>
  version({
    agent_id: id,
    version: 2,
    status: 'published',
    agent: {
      status: 'published',
      lock_version: 1,
      published_version: 2,
      open_version: null,
      created_by: 'user-2',
    },
    ...overrides,
  });

/** `api.call` answering by operation name; an operation without a handler fails the test. */
function fakeApi(handlers: Record<string, Handler> = {}) {
  const all: Record<string, Handler> = {
    getMine: () => ({ items: [], quotas }),
    getModels: () => ({ version: 1, items: context.models }),
    getCatalog: () => ({ items: context.catalog }),
    listGroups: () => ({ items: context.groups }),
    getOrg: () => ({ root: 'platform', nodes: orgNodes }),
    ...handlers,
  };
  const call = vi.fn((id: string, input: Parameters<Handler>[0] = {}) => {
    const handler = all[id];
    if (!handler) return Promise.reject(new Error(`unexpected operation ${id}`));
    try {
      return Promise.resolve(handler(input));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('failed'));
    }
  });
  const getBudgets = vi.fn(() => Promise.resolve(budgetsFixture()));
  return { call, getBudgets };
}

const WRITES = ['postAgent', 'postVersion', 'putVersion', 'submitVersion', 'reopenVersion'];
const writes = (api: ReturnType<typeof fakeApi>) =>
  api.call.mock.calls.filter(([id]) => WRITES.includes(id)).map(([id]) => id);
const bodyOf = (api: ReturnType<typeof fakeApi>, id: string) =>
  api.call.mock.calls.find(([called]) => called === id)?.[1]?.body;

function Marketplace() {
  const location = useLocation();
  return <p>marketplace:{JSON.stringify(location.state)}</p>;
}

function renderPage(
  api: ReturnType<typeof fakeApi>,
  {
    path = '/admin',
    isAdmin = true,
    canCreate = true,
  }: {
    path?: string | { pathname: string; state: unknown };
    isAdmin?: boolean;
    canCreate?: boolean;
  } = {},
) {
  return render(
    <TestProviders
      path={path}
      session={sessionValue({
        api: api as unknown as ApiClient,
        me: { ...baseMe, is_admin: isAdmin, can: { create_agent: canCreate } },
      })}
    >
      <Routes>
        <Route path="admin/*" element={<AgentBuilderPage />} />
        <Route path="marketplace" element={<Marketplace />} />
      </Routes>
    </TestProviders>,
  );
}

/** Fills what a new agent needs to pass the local checks. */
async function fillNewAgent(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Nombre'), 'Analista LATAM');
  await user.selectOptions(screen.getByLabelText('Reporta a'), 'finops');
  await user.type(screen.getByLabelText('Rol'), 'Analista');
  await user.type(screen.getByLabelText('System prompt'), 'Analiza el gasto.');
  await user.click(screen.getByRole('button', { name: /^per_user/ }));
  await user.click(screen.getByRole('button', { name: 'finops-central' }));
}

beforeAll(() => {
  // jsdom does not implement element scrolling.
  Element.prototype.scrollTo = () => undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentBuilderPage', () => {
  it('does not offer the builder without the permission to create agents', async () => {
    const api = fakeApi();
    renderPage(api, { canCreate: false });
    expect(await screen.findByText('No puedes crear agentes')).toBeInTheDocument();
    expect(api.call).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Enviar a aprobación' })).toBeNull();
  });

  it('shows the six sections, the preview, the checklist and the quotas', async () => {
    renderPage(fakeApi());
    expect(await screen.findByRole('heading', { name: 'Nuevo agente' })).toBeInTheDocument();
    for (const title of [
      'Información básica',
      'Organización',
      'Modelo e instrucciones',
      'Tools',
      'Límites',
      'Acceso',
    ]) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
    expect(screen.getByText('Sin nombre')).toBeInTheDocument();
    expect(screen.getByText('antes de enviar')).toBeInTheDocument();
    expect(screen.getByText('2 / 20')).toBeInTheDocument();
    expect(screen.getByText('1 / 5')).toBeInTheDocument();
    // Sent to approval, never published from here.
    expect(screen.getByRole('button', { name: 'Enviar a aprobación' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publicar/i })).toBeNull();
    // Only enabled connectors are offered.
    expect(screen.queryByText('Billing')).toBeNull();
    // The budget is read-only and comes from Presupuestos.
    expect(screen.getAllByText(/^USD 2\.?000,00$/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Ver en Presupuestos →' })).toBeInTheDocument();
  });

  it('needs a name to save a draft', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderPage(api);
    await user.click(await screen.findByRole('button', { name: 'Guardar borrador' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('No se pudo guardar');
    expect(alert).toHaveTextContent('Ponle un nombre para guardar el borrador.');
    expect(screen.getByText('Escribe un nombre')).toBeInTheDocument();
    expect(writes(api)).toEqual([]);
  });

  it('saves a new agent as a draft and goes back to the marketplace', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ postAgent: () => version() });
    renderPage(api);
    await user.type(await screen.findByLabelText('Nombre'), '  Analista LATAM ');
    await user.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    expect(await screen.findByText(/marketplace:.*draft_saved/)).toBeInTheDocument();
    expect(writes(api)).toEqual(['postAgent']);
    expect(bodyOf(api, 'postAgent')).toMatchObject({
      definition: {
        name: 'Analista LATAM',
        description: 'Agente FinOps',
        model: 'model.main',
        allowed_models: ['model.main'],
        reports_to: null,
      },
    });
  });

  it('lists what is missing by section and sends nothing', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderPage(api);
    await user.click(await screen.findByRole('button', { name: 'Enviar a aprobación' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('No se pudo enviar: 5 problemas');
    for (const text of [
      'Falta el nombre del agente.',
      'Elige a quién reporta el agente.',
      'Escribe el rol del agente.',
      'Faltan las instrucciones.',
      'Elige al menos un grupo que pueda usarlo.',
    ]) {
      expect(alert).toHaveTextContent(text);
    }
    expect(within(alert).getAllByRole('button', { name: 'Ir' })).toHaveLength(5);
    for (const text of [
      'Escribe un nombre',
      'Elige a quién reporta',
      'Escribe el rol',
      'Elige al menos un grupo',
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(writes(api)).toEqual([]);
    // Editing clears the notice.
    await user.type(screen.getByLabelText('Nombre'), 'A');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stores the draft and sends that revision to approval', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      postAgent: () => version({ revision: 3 }),
      submitVersion: () => version({ status: 'in_review' }),
    });
    renderPage(api);
    await fillNewAgent(user);
    await user.click(screen.getByRole('button', { name: 'Enviar a aprobación' }));
    expect(await screen.findByText(/marketplace:.*submitted/)).toBeInTheDocument();
    expect(writes(api)).toEqual(['postAgent', 'submitVersion']);
    expect(api.call).toHaveBeenCalledWith('submitVersion', {
      path: { agent_id: AGENT_ID, version: 1 },
      body: { revision: 3 },
    });
    expect(bodyOf(api, 'postAgent')).toMatchObject({
      definition: {
        reports_to: 'finops',
        role: 'Analista',
        tools: ['cost-explorer.per_user'],
        groups: ['finops-central'],
      },
    });
  });

  it('marks write tools for approval', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ postAgent: () => version() });
    renderPage(api);
    await user.type(await screen.findByLabelText('Nombre'), 'Operador');
    const stop = screen.getByRole('button', { name: /^stop/ });
    expect(stop).toHaveTextContent('Escritura · confirmación o aprobación');
    await user.click(stop);
    expect(screen.getByText(/1 tool elegida · 1 de escritura/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await screen.findByText(/marketplace:/);
    expect(bodyOf(api, 'postAgent')).toMatchObject({
      definition: { tools: ['ops.stop'], approval_tools: ['ops.stop'] },
    });
  });

  it('shows the rules the server reports, even when the local checks pass', async () => {
    const user = userEvent.setup();
    const stored = version({ definition: definition({ name: 'Analista LATAM' }) });
    const api = fakeApi({
      postAgent: () => stored,
      submitVersion: () => {
        throw new ApiError(422, 'validation_failed', 'the version does not meet the review rules');
      },
      readVersion: () =>
        version({
          ...stored,
          violations: [
            { code: 'reports_to_cycle', field: 'reports_to', items: ['finops'] },
            { code: 'model_not_enabled', field: 'allowed_models', items: ['model.main'] },
          ],
        }),
    });
    renderPage(api);
    await fillNewAgent(user);
    await user.click(screen.getByRole('button', { name: 'Enviar a aprobación' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No se pudo enviar: 2 problemas');
    expect(alert).toHaveTextContent(
      'El supervisor elegido reporta, directa o indirectamente, a este agente. Elige otro para no crear un ciclo.',
    );
    expect(alert).toHaveTextContent(
      'Uno de los modelos ya no está habilitado en Brains. Elige otro.',
    );
    // The server's own message is never shown.
    expect(alert).not.toHaveTextContent('review rules');
    expect(screen.getByText('Elige a quién reporta')).toBeInTheDocument();
    // Still on the form; the agent exists now, so it is not created twice.
    await user.selectOptions(screen.getByLabelText('Reporta a'), 'platform');
    await user.click(screen.getByRole('button', { name: 'Enviar a aprobación' }));
    await screen.findByRole('alert');
    expect(writes(api).filter((id) => id === 'postAgent')).toHaveLength(1);
  });

  it('takes the rules from the 422 itself, without reading the version again', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      postAgent: () => version({ definition: definition({ name: 'Analista LATAM' }) }),
      submitVersion: () => {
        throw new ApiError(
          422,
          'validation_failed',
          'the version does not meet the review rules',
          null,
          [{ code: 'reports_to_cycle', field: 'reports_to', items: ['finops'] }],
        );
      },
    });
    renderPage(api);
    await fillNewAgent(user);
    await user.click(screen.getByRole('button', { name: 'Enviar a aprobación' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('El supervisor elegido reporta, directa o indirectamente');
    expect(alert).not.toHaveTextContent('review rules');
    expect(api.call.mock.calls.filter(([id]) => id === 'readVersion')).toEqual([]);
  });

  it('explains the daily limit when the API answers 429', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      postAgent: () => version(),
      submitVersion: () => {
        throw new ApiError(429, 'submission_limit', 'limit', 3600);
      },
    });
    renderPage(api);
    await fillNewAgent(user);
    await user.click(screen.getByRole('button', { name: 'Enviar a aprobación' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Alcanzaste el límite diario de envíos a revisión. Podrás enviar de nuevo mañana.',
    );
  });

  it('warns about a secret in the instructions without repeating it', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderPage(api);
    await fillNewAgent(user);
    // Split so secret scanners do not take the fixture for a real key.
    const secret = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    await user.type(screen.getByLabelText('System prompt'), ` clave ${secret}`);
    const warning = screen.getByText(/Posible secreto detectado/);
    expect(warning).toHaveTextContent('clave de acceso de AWS');
    expect(warning).not.toHaveTextContent(secret);
    expect(screen.getByLabelText('System prompt')).toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByRole('button', { name: 'Enviar a aprobación' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Se detectó un posible secreto (clave de acceso de AWS) en las instrucciones.',
    );
    expect(alert).not.toHaveTextContent(secret);
    expect(writes(api)).toEqual([]);
  });

  it('names only the kind and the field of a secret in the description', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderPage(api);
    await fillNewAgent(user);
    await user.type(screen.getByLabelText('Descripción'), 'password: hunter2222');
    const field = screen.getByLabelText('Descripción');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(
      screen.getByText('Posible secreto detectado (contraseña). No pegues credenciales.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enviar a aprobación' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Se detectó un posible secreto (contraseña) en la descripción.',
    );
    expect(alert).not.toHaveTextContent('hunter2222');
    expect(writes(api)).toEqual([]);
  });

  it('warns when organization-wide tools meet a group that is not central', async () => {
    const user = userEvent.setup();
    renderPage(fakeApi());
    await user.click(await screen.findByRole('button', { name: /^org_wide/ }));
    expect(screen.queryByText(/No se podrá enviar así/)).toBeNull();
    const retail = screen.getByRole('button', { name: /^bu-retail/ });
    expect(retail).toHaveTextContent('área · retail');
    await user.click(retail);
    expect(screen.getByText(/No se podrá enviar así/)).toHaveTextContent(
      'Hay tools solo para grupos centrales y el agente es visible para grupos que no son centrales (bu-retail). No se podrá enviar así.',
    );
    // The rule is per tool: the one that filters per user carries no badge.
    expect(screen.getByRole('button', { name: /^org_wide/ })).toHaveTextContent(
      'Solo grupos centrales',
    );
    expect(screen.getByRole('button', { name: /^per_user/ })).not.toHaveTextContent(
      'Solo grupos centrales',
    );
  });

  it('marks the tools that need an AWS service Mango does not check', async () => {
    renderPage(fakeApi());
    const badge = await screen.findByText('Requiere Compute Optimizer');
    expect(badge).toHaveAttribute(
      'title',
      'Responde con error si la cuenta pagadora no tiene activado Compute Optimizer; Mango no lo comprueba',
    );
    expect(screen.getByRole('button', { name: /^org_wide/ })).toContainElement(badge);
    expect(screen.getByRole('button', { name: /^per_user/ })).not.toHaveTextContent('Requiere');
  });

  it('lists the people of a version, lets them go and does not send tools for central groups with them', async () => {
    const user = userEvent.setup();
    const shared = version({
      definition: definition({
        tools: ['cost-explorer.org_wide'],
        users: ['user-7', 'user-8'],
      }),
    });
    const api = fakeApi({
      getMine: () => ({ items: [{ agent_id: AGENT_ID, version: 1 }], quotas }),
      readVersion: () => shared,
      putVersion: ({ body }) => ({ ...shared, revision: 2, definition: body?.definition }),
      submitVersion: () => ({ ...shared, status: 'in_review' }),
    });
    renderPage(api, { path: `/admin/${AGENT_ID}` });
    const people = (await screen.findByText('Personas')).closest('.ab-field') as HTMLElement;
    expect(within(people).getByText('user-7')).toBeInTheDocument();
    expect(screen.getByText(/No se podrá enviar así/)).toHaveTextContent(
      'el agente es visible para personas sueltas',
    );
    // The directory did not answer (no handler): the identifiers stay on screen.
    await waitFor(() => {
      expect(api.call).toHaveBeenCalledWith('resolveUsers', {
        body: { ids: ['user-7', 'user-8'] },
      });
    });
    expect(within(people).queryByText('Próximamente')).toBeNull();
    expect(within(people).getByPlaceholderText('correo@empresa.com')).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Enviar a aprobación' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Tiene tools solo para grupos centrales y está compartido con personas sueltas.',
    );
    expect(
      within(people).getByText('Quita a las personas o las tools solo para grupos centrales'),
    ).toBeInTheDocument();
    expect(writes(api)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Quitar user-7' }));
    await user.click(screen.getByRole('button', { name: 'Quitar user-8' }));
    expect(screen.queryByText(/No se podrá enviar así/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Enviar a aprobación' }));
    await screen.findByText(/marketplace:/);
    expect(bodyOf(api, 'putVersion')).toMatchObject({ definition: { users: [] } });
  });

  it('shows the people of a version by email and adds one from the directory', async () => {
    const user = userEvent.setup();
    const shared = version({ definition: definition({ users: ['user-7', 'user-8'] }) });
    const directory: Record<string, string> = {
      'user-7': 'ana@empresa.com',
      'user-9': 'luis@empresa.com',
    };
    const resolveUsers = vi.fn(({ body }: Parameters<Handler>[0]) => {
      const ids = (body?.ids ?? []) as string[];
      const emails = (body?.emails ?? []) as string[];
      const byEmail = emails.flatMap((email) =>
        Object.entries(directory).filter(([, known]) => known === email),
      );
      const byId = ids.flatMap((id) => (directory[id] ? [[id, directory[id]] as const] : []));
      return {
        users: [...byEmail, ...byId].map(([id, email]) => ({ id, email })),
        emails_not_found: emails.filter((email) => !Object.values(directory).includes(email)),
        ids_not_found: ids.filter((id) => !directory[id]),
      };
    });
    const api = fakeApi({
      getMine: () => ({ items: [{ agent_id: AGENT_ID, version: 1 }], quotas }),
      readVersion: () => shared,
      putVersion: ({ body }) => ({ ...shared, revision: 2, definition: body?.definition }),
      resolveUsers,
    });
    renderPage(api, { path: `/admin/${AGENT_ID}` });
    const people = (await screen.findByText('Personas')).closest('.ab-field') as HTMLElement;
    // Emails instead of identifiers; one the directory does not know stays as it is.
    expect(await within(people).findByText('ana@empresa.com')).not.toHaveClass('mono');
    expect(within(people).queryByText('user-7')).toBeNull();
    expect(within(people).getByText('user-8')).toHaveClass('mono');
    expect(resolveUsers).toHaveBeenCalledTimes(1);

    const input = within(people).getByRole('textbox', { name: 'Agregar persona por correo' });
    const add = within(people).getByRole('button', { name: 'Agregar' });
    expect(add).toBeDisabled();
    await user.type(input, 'no-es-correo');
    expect(within(people).getByText('Escribe un correo válido')).toBeInTheDocument();
    expect(add).toBeDisabled();

    // Normalized like the design (trim + lowercase) and looked up on the server.
    await user.clear(input);
    await user.type(input, '  Luis@Empresa.com ');
    await user.click(add);
    expect(await within(people).findByText('luis@empresa.com')).toBeInTheDocument();
    expect(resolveUsers).toHaveBeenLastCalledWith({ body: { emails: ['luis@empresa.com'] } });
    expect(input).toHaveValue('');
    // The identifier just added is already known: no second lookup by id.
    expect(resolveUsers).toHaveBeenCalledTimes(2);

    // Adding the same person again changes nothing.
    await user.type(input, 'luis@empresa.com{Enter}');
    expect(input).toHaveValue('');
    expect(within(people).getAllByText('luis@empresa.com')).toHaveLength(1);

    await user.type(input, 'nadie@empresa.com{Enter}');
    expect(await within(people).findByText('Ese correo no está en el directorio')).toHaveClass(
      'ab-error',
    );
    expect(input).toHaveValue('nadie@empresa.com');
    // Editing the email clears the error of the lookup.
    await user.type(input, 'x');
    expect(within(people).queryByText('Ese correo no está en el directorio')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Quitar ana@empresa.com' }));
    await user.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await screen.findByText(/marketplace:/);
    // The API stores identifiers, never emails.
    expect(bodyOf(api, 'putVersion')).toMatchObject({
      definition: { users: ['user-8', 'user-9'] },
    });
  });

  it.each([
    [new ApiError(429, 'rate_limited', 'slow down', 60), 'Hiciste demasiadas búsquedas.'],
    [new ApiError(502, 'upstream_error', '<b>raw</b>'), 'No se pudo buscar el correo.'],
  ])('explains a lookup the server refused (%s)', async (error, text) => {
    const user = userEvent.setup();
    const api = fakeApi({
      resolveUsers: () => {
        throw error;
      },
    });
    renderPage(api);
    const people = (await screen.findByText('Personas')).closest('.ab-field') as HTMLElement;
    await user.type(
      within(people).getByRole('textbox', { name: 'Agregar persona por correo' }),
      'ana@empresa.com{Enter}',
    );
    expect(await within(people).findByText(text, { exact: false })).toBeInTheDocument();
    // The server's message is never shown.
    expect(screen.queryByText(/slow down|raw/)).toBeNull();
    expect(within(people).queryByRole('listitem')).toBeNull();
  });

  it('keeps a token limit outside the options and sends the new per-call limits', async () => {
    const user = userEvent.setup();
    const release = version({
      definition: definition({
        category: 'Costos',
        limits: {
          max_tokens: 8000,
          max_iterations: 8,
          timeout_seconds: 120,
          max_tokens_per_call: null,
          temperature: null,
        },
      }),
    });
    const api = fakeApi({
      getMine: () => ({ items: [{ agent_id: AGENT_ID, version: 1 }], quotas }),
      readVersion: () => release,
      putVersion: ({ body }) => ({ ...release, revision: 2, definition: body?.definition }),
    });
    renderPage(api, { path: `/admin/${AGENT_ID}` });
    expect(
      await screen.findByText('Actual: 8,000 · se conserva si no eliges otro'),
    ).toBeInTheDocument();
    // A category outside the design's list is one more segment, and stays chosen.
    expect(screen.getByRole('button', { name: 'Costos' })).toHaveAttribute('aria-pressed', 'true');
    // Until the version sets them, the per-call controls show the defaults.
    const perCall = screen.getByRole('group', { name: 'Tokens por llamada' });
    expect(within(perCall).getByRole('button', { name: '4,096' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Temperatura')).toHaveValue('0.2');

    await user.click(within(perCall).getByRole('button', { name: '2,048' }));
    await user.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await screen.findByText(/marketplace:/);
    expect(bodyOf(api, 'putVersion')).toMatchObject({
      definition: {
        category: 'Costos',
        limits: { max_tokens: 8000, max_tokens_per_call: 2048, temperature: null },
      },
    });
  });

  it('locks a version that is in review', async () => {
    const inReview = version({
      status: 'in_review',
      submitted_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    const api = fakeApi({
      getMine: () => ({ items: [{ agent_id: AGENT_ID, version: 1 }], quotas }),
      readVersion: () => inReview,
    });
    renderPage(api, { path: `/admin/${AGENT_ID}` });
    expect(await screen.findByText(/Lo enviado a revisión ya no se edita/)).toHaveTextContent(
      'En revisión desde hace 2 h',
    );
    expect(screen.getByLabelText('Nombre')).toBeDisabled();
    expect(screen.getByLabelText('System prompt')).toBeDisabled();
    expect(screen.getByRole('button', { name: /^per_user/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Guardar borrador' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enviar a aprobación' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Volver' })).toHaveAttribute('href', '/marketplace');
    expect(screen.getByRole('link', { name: 'Ver en Revisión' })).toHaveAttribute(
      'href',
      '/review',
    );
    // No templates for an agent that already exists.
    expect(screen.queryByText('Plantilla')).toBeNull();
  });

  it('starts a change from the published version and stores it on the first save', async () => {
    const user = userEvent.setup();
    const live = published('finops', { definition: definition({ name: 'FinOps' }) });
    const draft = { ...live, version: 3, status: 'draft', revision: 1, base: live.definition };
    const api = fakeApi({
      getAgent: () => ({ version: 2 }),
      readVersion: () => live,
      postVersion: () => draft,
      putVersion: () => ({ ...draft, revision: 2 }),
    });
    renderPage(api, { path: '/admin/finops' });
    expect(await screen.findByRole('heading', { name: 'Editar agente' })).toBeInTheDocument();
    expect(screen.getByText(/La versión publicada sigue activa/)).toHaveTextContent(
      'Estás editando un borrador de FinOps',
    );
    expect(writes(api)).toEqual([]);

    // «Reporta a» offers neither the agent itself nor the agents below it.
    const options = within(screen.getByLabelText('Reporta a'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual([
      'Elige un supervisor…',
      'Platform Admin · supervisor raíz',
      'Etiquetado · Rol de Etiquetado',
    ]);

    await user.clear(screen.getByLabelText('Rol'));
    await user.type(screen.getByLabelText('Rol'), 'Analista senior');
    expect(screen.getByText(/La versión publicada sigue activa/)).toHaveTextContent(
      '1 cambio por ahora.',
    );
    await user.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await screen.findByText(/marketplace:.*draft_saved/);
    expect(writes(api)).toEqual(['postVersion', 'putVersion']);
    expect(api.call).toHaveBeenCalledWith(
      'putVersion',
      expect.objectContaining({ path: { agent_id: 'finops', version: 3 } }),
    );
    expect(bodyOf(api, 'putVersion')).toMatchObject({
      revision: 1,
      definition: { role: 'Analista senior' },
    });
  });

  it('shows a rejection and what other people wrote as text', async () => {
    const rejected = version({
      rejection_reason: '<img src=x onerror=alert(1)> Falta el rol.',
      definition: definition({ name: 'Resumen <b>semanal</b>' }),
    });
    const api = fakeApi({
      getMine: () => ({ items: [{ agent_id: AGENT_ID, version: 1 }], quotas }),
      readVersion: () => rejected,
    });
    const { container } = renderPage(api, { path: `/admin/${AGENT_ID}` });
    expect(await screen.findByText('Rechazado')).toBeInTheDocument();
    expect(screen.getByText(/Corrígelo y vuelve a enviarlo/)).toHaveTextContent(
      '<img src=x onerror=alert(1)> Falta el rol.',
    );
    expect(screen.getByLabelText('Nombre')).toHaveValue('Resumen <b>semanal</b>');
    expect(screen.getAllByText('Resumen <b>semanal</b>').length).toBeGreaterThan(0);
    expect(container.querySelector('img, script, b > b')).toBeNull();
    // A rejected version is a draft again: it can be edited and sent.
    expect(screen.getByRole('button', { name: 'Enviar a aprobación' })).toBeEnabled();
  });

  it('reopens a failed publication before saving it', async () => {
    const user = userEvent.setup();
    const failed = version({ status: 'failed', failed_step: 'create_harness', revision: 4 });
    const api = fakeApi({
      getMine: () => ({ items: [{ agent_id: AGENT_ID, version: 1 }], quotas }),
      readVersion: () => failed,
      reopenVersion: () => ({ ...failed, status: 'draft', revision: 5 }),
      putVersion: () => ({ ...failed, status: 'draft', revision: 6 }),
    });
    renderPage(api, { path: `/admin/${AGENT_ID}` });
    expect(
      (await screen.findByText(/La publicación falló/)).closest('.mc-alert'),
    ).toHaveTextContent(
      'La publicación falló en «create_harness». Un administrador puede reintentarla desde Revisión pasados 45 minutos, o puedes reabrirla como borrador para corregirla.',
    );
    await user.type(screen.getByLabelText('Rol'), ' senior');
    await user.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await screen.findByText(/marketplace:/);
    expect(writes(api)).toEqual(['reopenVersion', 'putVersion']);
    expect(bodyOf(api, 'putVersion')).toMatchObject({ revision: 5 });
  });

  it('reopens a failed publication as a draft and stays in the Builder', async () => {
    const user = userEvent.setup();
    const failed = version({ status: 'failed', failed_step: null, revision: 4 });
    const api = fakeApi({
      getMine: () => ({ items: [{ agent_id: AGENT_ID, version: 1 }], quotas }),
      readVersion: () => failed,
      reopenVersion: () => ({ ...failed, status: 'draft', revision: 5 }),
    });
    renderPage(api, { path: `/admin/${AGENT_ID}` });
    const notice = (await screen.findByText(/La publicación falló/)).closest(
      '.mc-alert',
    ) as HTMLElement;
    // Without a recorded step the design names the expired publication.
    expect(notice).toHaveTextContent('La publicación falló en «publication_expired».');
    await user.click(within(notice).getByRole('button', { name: 'Reabrir como borrador' }));
    expect(await screen.findByText('Reabierto como borrador')).toBeInTheDocument();
    expect(screen.queryByText(/La publicación falló/)).toBeNull();
    expect(screen.getByText('Borrador')).toBeInTheDocument();
    expect(writes(api)).toEqual(['reopenVersion']);
    expect(api.call.mock.calls.find(([id]) => id === 'reopenVersion')?.[1]).toMatchObject({
      path: { agent_id: AGENT_ID, version: 1 },
    });
  });

  it('says a draft is a copy for as long as it is open, with the name as text', async () => {
    const api = fakeApi({ readVersion: () => version() });
    renderPage(api, {
      path: { pathname: `/admin/${AGENT_ID}/1`, state: { clonedFrom: 'FinOps <b>x</b>' } },
    });
    const notice = (await screen.findByText(/guardada como borrador/)).closest(
      '.mc-alert',
    ) as HTMLElement;
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent(
      'Copia de FinOps <b>x</b> guardada como borrador. Envíala a aprobación para publicarla.',
    );
    expect(notice.querySelectorAll('b')).toHaveLength(1);
  });

  it('keeps «Enviar» and a menu with the rest in a bar of 560 px or less', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 560px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const user = userEvent.setup();
    const api = fakeApi({ postAgent: () => version() });
    renderPage(api);
    expect(await screen.findByRole('button', { name: 'Enviar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Guardar borrador' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Cancelar' })).toBeNull();
    const more = screen.getByRole('button', { name: 'Más acciones' });
    await user.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Guardar borrador',
      'Cancelar',
    ]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(more).toHaveFocus();
    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: 'Guardar borrador' }));
    // The same checks as the full bar: a draft needs a name.
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo guardar');
    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: 'Cancelar' }));
    expect(await screen.findByText(/marketplace:/)).toBeInTheDocument();
    expect(writes(api)).toEqual([]);
  });

  it('applies a template to identity and instructions, and starts with no access', async () => {
    const user = userEvent.setup();
    renderPage(fakeApi());
    await user.click(await screen.findByRole('button', { name: 'Analista FinOps' }));
    expect(screen.getByRole('button', { name: 'finops-central' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByLabelText('Nombre')).toHaveValue('Analista FinOps');
    expect(screen.getByLabelText<HTMLTextAreaElement>('System prompt').value).toContain(
      'Primero consulta Cost Explorer',
    );
    expect(screen.getByText('0 tools elegidas')).toBeInTheDocument();
  });

  it('does not ask for budgets or link to admin screens for a creator who is not an admin', async () => {
    const api = fakeApi();
    renderPage(api, { isAdmin: false });
    expect(await screen.findByRole('heading', { name: 'Nuevo agente' })).toBeInTheDocument();
    expect(api.getBudgets).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Ver en Presupuestos →' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Ajustes › Grupos' })).toBeNull();
    // The budget is not part of the version; who is not an admin sees no amount and no link.
    const budget = screen.getByText('Presupuesto mensual').closest('.ab-field') as HTMLElement;
    expect(budget).toHaveTextContent('Fuera de la versión · al llegar al 100 % se bloquea');
    expect(budget.querySelector('.ro-field')).toHaveTextContent('—');
    expect(budget).toHaveTextContent('Solo los administradores ven el presupuesto.');
    expect(screen.getByText(/Los grupos los gestiona un administrador\./)).toBeInTheDocument();
  });

  it.each([
    '/admin/..%2Fadmin%2Fbudgets',
    '/admin/UPPER',
    `/admin/${AGENT_ID}/0`,
    `/admin/${AGENT_ID}/1/x`,
  ])('rejects %s before calling the API', async (path) => {
    const api = fakeApi();
    renderPage(api, { path });
    expect(await screen.findByText('No encontramos este agente')).toBeInTheDocument();
    expect(api.call.mock.calls.filter(([id]) => id === 'readVersion' || id === 'getAgent')).toEqual(
      [],
    );
  });

  it("opens the version the URL names, even when it is not the caller's", async () => {
    const failed = version({
      version: 3,
      status: 'failed',
      created_by: 'user-2',
      is_author: false,
    });
    const api = fakeApi({ readVersion: () => failed });
    renderPage(api, { path: `/admin/${AGENT_ID}/3` });
    expect(await screen.findByText(/La publicación falló/)).toBeInTheDocument();
    expect(api.call).toHaveBeenCalledWith('readVersion', {
      path: { agent_id: AGENT_ID, version: 3 },
    });
    expect(api.call.mock.calls.some(([id]) => id === 'getAgent')).toBe(false);
  });

  it('tells apart an agent the caller may not edit and a failed load', async () => {
    const forbidden = fakeApi({
      getAgent: () => {
        throw new ApiError(403, 'forbidden', 'not allowed');
      },
    });
    const { unmount } = renderPage(forbidden, { path: '/admin/finops' });
    expect(await screen.findByText('No puedes editar este agente')).toBeInTheDocument();
    unmount();

    const user = userEvent.setup();
    let fail = true;
    const flaky = fakeApi({
      getModels: () => {
        if (fail) throw new ApiError(503, 'models_unavailable', 'x');
        return { version: 1, items: context.models };
      },
    });
    renderPage(flaky);
    expect(await screen.findByText('No pudimos cargar el agente')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('heading', { name: 'Nuevo agente' })).toBeInTheDocument();
  });
});
