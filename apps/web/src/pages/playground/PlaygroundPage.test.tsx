import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, StreamPlaygroundRequest } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { PlaygroundEvent } from '../../api/playgroundEvents';
import { agentFixture, baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { AGENT_ID, context, definition, quotas, version } from '../agentBuilder/testFixtures';
import { list as skillList, skill } from '../skills/testFixtures';
import { PlaygroundPage } from './PlaygroundPage';

const creator = { ...baseMe, can: { create_agent: true } };

const DRAFT = version({
  version: 2,
  revision: 4,
  base_version: 1,
  agent: {
    status: 'published',
    lock_version: 1,
    published_version: 1,
    open_version: 2,
    created_by: 'user-1',
  },
  base: definition(),
});

const DONE: PlaygroundEvent = {
  type: 'done',
  stop_reason: 'end_turn',
  usage: { input_tokens: 1234, output_tokens: 321 },
  cost_usd: '0.0123',
  duration_ms: 2100,
  flags: { guardrail: false, token_cap: false, time_limit: false, iteration_limit: false },
};

type Stream = (request: StreamPlaygroundRequest) => Promise<void>;

function apiWith(answers: Partial<Record<string, unknown>> = {}, stream?: Stream) {
  const defaults: Record<string, unknown> = {
    getMine: {
      items: [
        {
          agent_id: AGENT_ID,
          version: 2,
          revision: 4,
          status: 'draft',
          base_version: 1,
          name: 'Analista de costos',
          description: '',
          category: 'FinOps',
          icon: 'Money',
          color: 1,
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-01T00:00:00Z',
          submitted_at: null,
          rejected_at: null,
          rejection_reason: null,
          failed_step: null,
        },
      ],
      quotas,
    },
    getAgents: { items: [agentFixture({ id: 'finops', is_mine: true })] },
    getModels: { items: context.models, version: 1 },
    getCatalog: { items: context.catalog },
    listGroups: { items: context.groups },
    getSkills: new Error('no skills'),
    readVersion: DRAFT,
  };
  const call = vi.fn<(operation: string, input?: unknown) => Promise<unknown>>((operation) => {
    const answer = operation in answers ? answers[operation] : defaults[operation];
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${operation}`));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  const streamPlayground = vi.fn<Stream>(
    stream ??
      ((request) => {
        request.onEvent({ type: 'delta', text: 'Respuesta' });
        request.onEvent(DONE);
        return Promise.resolve();
      }),
  );
  return { call, streamPlayground, api: { call, streamPlayground } as unknown as ApiClient };
}

function renderPage(api: ApiClient, me = creator) {
  render(
    <TestProviders session={sessionValue({ api, me })}>
      <PlaygroundPage />
    </TestProviders>,
  );
}

async function ready() {
  await screen.findByLabelText('System prompt');
}

async function ask(question: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Mensaje de prueba'), question);
  await user.click(screen.getByRole('button', { name: 'Ejecutar' }));
  return user;
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
  vi.useRealTimers();
});

describe('PlaygroundPage', () => {
  it('denies whoever does not edit agents, without calling the API', () => {
    const { api, call } = apiWith();
    renderPage(api, baseMe);
    expect(screen.getByText('No tienes acceso al Playground')).toBeInTheDocument();
    expect(call).not.toHaveBeenCalled();
  });

  it('says when there is nothing to test', async () => {
    const { api } = apiWith({ getMine: { items: [], quotas }, getAgents: { items: [] } });
    renderPage(api);
    expect(await screen.findByText('No tienes nada que probar')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Crear agente' })).toHaveAttribute('href', '/admin');
  });

  it('offers to retry when the list cannot be read', async () => {
    // Read at call time: the second read works.
    const answers: Record<string, unknown> = { getAgents: new Error('down') };
    const { api } = apiWith(answers);
    renderPage(api);
    expect(await screen.findByText('No se pudieron cargar tus agentes')).toBeInTheDocument();
    answers.getAgents = { items: [] };
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reintentar' }));
    await ready();
  });

  it('runs one test of the draft on screen and renders the answer without raw HTML', async () => {
    const { api, streamPlayground } = apiWith({}, (request) => {
      request.onEvent({ type: 'tool', name: 'get_cost_and_usage', status: 'started' });
      request.onEvent({ type: 'tool', name: 'get_cost_and_usage', status: 'completed' });
      request.onEvent({ type: 'delta', text: '**Hola** <img src=x onerror="alert(1)">' });
      request.onEvent(DONE);
      return Promise.resolve();
    });
    renderPage(api);
    await ready();
    await ask('¿Qué puedes hacer?');
    expect(await screen.findByText('Hola')).toBeInTheDocument();
    expect(document.querySelector('.pg-card img')).toBeNull();
    expect(screen.getByText('USD 0,0123')).toBeInTheDocument();
    expect(screen.getByText('1.234 in · 321 out')).toBeInTheDocument();
    expect(streamPlayground).toHaveBeenCalledOnce();
    expect(streamPlayground.mock.calls[0]?.[0]).toMatchObject({
      agentId: AGENT_ID,
      version: 2,
      revision: 4,
      message: '¿Qué puedes hacer?',
      overrides: {},
    });
  });

  it('sends only what changed on screen', async () => {
    const { api, streamPlayground } = apiWith();
    renderPage(api);
    await ready();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Modelo'), 'model.fast');
    await ask('Hola');
    await waitFor(() => {
      expect(streamPlayground).toHaveBeenCalledOnce();
    });
    expect(streamPlayground.mock.calls[0]?.[0].overrides).toEqual({ model: 'model.fast' });
    expect(screen.getByText('Cambios sin guardar')).toBeInTheDocument();
  });

  it('blocks every test while the prompt looks like it has a secret', async () => {
    const { api, streamPlayground } = apiWith();
    renderPage(api);
    await ready();
    const user = userEvent.setup();
    // The example key of the AWS documentation: the secret scanner knows it is not real.
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    await user.type(screen.getByLabelText('System prompt'), ` ${secret}`);
    expect(screen.getByText('Hay un posible secreto en el prompt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ejecutar todas/ })).toBeDisabled();
    await user.type(screen.getByLabelText('Mensaje de prueba'), 'Hola{Enter}');
    expect(streamPlayground).not.toHaveBeenCalled();
  });

  it('runs two tests at a time and queues the rest', async () => {
    const pending: (() => void)[] = [];
    const { api, streamPlayground } = apiWith(
      {},
      (request) =>
        new Promise<void>((resolve) => {
          pending.push(() => {
            request.onEvent(DONE);
            resolve();
          });
        }),
    );
    renderPage(api);
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: /Ejecutar todas/ }));
    expect(document.querySelectorAll('.pg-run')).toHaveLength(4);
    expect(streamPlayground).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText(/^En cola/)).toHaveLength(2);
    await act(async () => {
      pending.shift()?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(streamPlayground).toHaveBeenCalledTimes(3);
    });
  });

  it('says whose budget ran out and stops the next tests', async () => {
    const { api } = apiWith({}, (request) => {
      request.onEvent({ type: 'error', code: 'budget_exceeded', scope: 'agent' });
      return Promise.resolve();
    });
    renderPage(api);
    await ready();
    await ask('Hola');
    expect(
      await screen.findByText('El presupuesto mensual de Analista de costos se agotó'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ejecutar todas/ })).toBeDisabled();
    expect(screen.getByText('No se pudo completar la respuesta.')).toBeInTheDocument();
  });

  it('counts down the rate limit from Retry-After', async () => {
    const { api } = apiWith({}, () => Promise.reject(new ApiError(429, 'rate_limited', 'x', 42)));
    renderPage(api);
    await ready();
    await ask('Hola');
    expect(await screen.findByText('Llegaste al límite de pruebas')).toBeInTheDocument();
    expect(screen.getByText(/Podrás probar de nuevo en (42|41) s\./)).toBeInTheDocument();
  });

  it('shows the whole screen as unavailable when the installation has no Playground', async () => {
    const { api } = apiWith({}, () =>
      Promise.reject(new ApiError(503, 'playground_unavailable', 'x')),
    );
    renderPage(api);
    await ready();
    await ask('Hola');
    expect(
      await screen.findByText('El Playground no está disponible en esta instalación'),
    ).toBeInTheDocument();
  });

  it('says a model calls no tools, over the answers and under the model', async () => {
    const { api } = apiWith({}, () =>
      Promise.reject(new ApiError(422, 'model_without_tools', 'x')),
    );
    renderPage(api);
    await ready();
    await ask('Hola');
    expect(
      await screen.findByText(
        'Modelo Principal no admite tools y este agente usa tools o knowledge bases.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Modelo Principal no admite tools. Elige uno que las admita.'),
    ).toHaveClass('pg-err');
    // Choosing another model lifts the block and the hint.
    await userEvent.setup().selectOptions(screen.getByLabelText('Modelo'), 'model.fast');
    expect(screen.queryByText(/no admite tools\. Elige uno/)).not.toBeInTheDocument();
  });

  it('counts the tools that failed in the header of the trace', async () => {
    const { api } = apiWith({}, (request) => {
      for (const name of ['get_cost_and_usage', 'get_budgets', 'list_accounts']) {
        request.onEvent({ type: 'tool', name, status: 'started' });
      }
      request.onEvent({ type: 'tool', name: 'get_cost_and_usage', status: 'error' });
      request.onEvent({ type: 'tool', name: 'get_budgets', status: 'completed' });
      request.onEvent({ type: 'tool', name: 'list_accounts', status: 'error' });
      request.onEvent(DONE);
      return Promise.resolve();
    });
    renderPage(api);
    await ready();
    await ask('Hola');
    const trace = await screen.findByRole('button', { name: /3 tools/ });
    expect(within(trace).getByText('2 fallaron')).toHaveClass('badge', 'badge-red');
  });

  it('says a retired agent cannot be tested and where to choose another', async () => {
    const { api } = apiWith({}, () => Promise.reject(new ApiError(409, 'agent_retired', 'x')));
    renderPage(api);
    await ready();
    await ask('Hola');
    expect(
      await screen.findByText('Ya no se puede probar. Elige otro en «Qué probar».'),
    ).toBeInTheDocument();
  });

  it('names the skills that are no longer approved and opens the draft in the Builder', async () => {
    const { api } = apiWith(
      {
        getSkills: skillList([skill()]),
        readVersion: {
          ...DRAFT,
          definition: definition({ skills: ['otra-skill@1', 'revision-de-costos@2'] }),
        },
      },
      () =>
        Promise.reject(
          new ApiError(422, 'skill_unavailable', 'x', null, null, ['revision-de-costos@2']),
        ),
    );
    renderPage(api);
    await ready();
    await ask('Hola');
    expect(
      await screen.findByText(
        'Revisión de costos v2 ya no está aprobada. Cámbiala en el Agent Builder para probar.',
        { exact: false },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Abrir en el Agent Builder' })).toHaveAttribute(
      'href',
      `/admin/${AGENT_ID}/2`,
    );
    // In the panel, only the one the server named is marked.
    const marked = screen.getByText('Ya no aprobada');
    expect(marked).toHaveClass('badge', 'badge-red');
    expect(marked.closest('.pg-tool')).toHaveTextContent('Revisión de costos');
    expect(marked.closest('.pg-tool')).toHaveClass('off');
    expect(screen.getByText('otra-skill').closest('.pg-tool')).not.toHaveClass('off');
    expect(screen.getByRole('button', { name: /Ejecutar todas/ })).toBeDisabled();
  });

  it('saves the draft at the revision on screen', async () => {
    const { api, call } = apiWith({ putVersion: { ...DRAFT, revision: 5 } });
    renderPage(api);
    await ready();
    const user = userEvent.setup();
    const prompt = screen.getByLabelText('System prompt');
    await user.clear(prompt);
    await user.type(prompt, 'Nuevo prompt');
    await user.click(screen.getByRole('button', { name: 'Guardar en borrador' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('putVersion', expect.anything());
    });
    const [, input] = call.mock.calls.find(([operation]) => operation === 'putVersion') ?? [];
    expect(input).toMatchObject({
      path: { agent_id: AGENT_ID, version: 2 },
      body: { revision: 4, definition: { system_prompt: 'Nuevo prompt', model: 'model.main' } },
    });
    expect(await screen.findByText('Borrador actualizado')).toBeInTheDocument();
  });

  it('says the draft changed in another tab when the save conflicts', async () => {
    const { api } = apiWith({ putVersion: new ApiError(409, 'version_conflict', 'x') });
    renderPage(api);
    await ready();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('System prompt'), ' más');
    await user.click(screen.getByRole('button', { name: 'Guardar en borrador' }));
    const banner = await screen.findByText('Este borrador cambió en otra pestaña');
    expect(
      within(banner.closest('.g-banner') as HTMLElement).getByRole('button', { name: 'Recargar' }),
    ).toBeInTheDocument();
  });
});
