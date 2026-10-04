import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../agents/agents';

import type { ChatEvent } from '../api/chatEvents';
import type { ApiClient } from '../api/client';
import type { SessionContextValue } from '../auth/SessionContext';
import { agentFixture, baseMe, finopsAgent, sessionValue } from '../test/fixtures';
import { TestProviders } from '../test/TestProviders';
import { ChatPage } from './ChatPage';

type StreamArgs = Parameters<ApiClient['streamChat']>[0];

/** API whose chat stream emits the given events and then waits until `finish` is called. */
function streamingApi(events: ChatEvent[]) {
  const pending: { finish: () => void } = { finish: () => undefined };
  const streamChat = vi.fn(
    ({ onEvent }: StreamArgs) =>
      new Promise<void>((resolve) => {
        events.forEach(onEvent);
        pending.finish = () => {
          onEvent({ type: 'tool', name: 'get_cost_and_usage', status: 'completed' });
          onEvent({ type: 'delta', text: 'Gastaron **USD 10**.' });
          onEvent({
            type: 'done',
            message_id: 'm1',
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
            cost_usd: '0.01',
          });
          resolve();
        };
      }),
  );
  return { api: { streamChat } as unknown as ApiClient, streamChat, pending };
}

function renderChat(
  api: ApiClient,
  isAdmin = false,
  { path = '/', session = {} }: { path?: string; session?: Partial<SessionContextValue> } = {},
) {
  render(
    <TestProviders
      session={sessionValue({ api, me: { ...baseMe, is_admin: isAdmin }, ...session })}
      path={path}
    >
      <Routes>
        <Route path="/" element={<ChatPage />} />
        <Route path="/c/:conversationId" element={<ChatPage />} />
      </Routes>
      <CurrentPath />
    </TestProviders>,
  );
}

function CurrentPath() {
  const { pathname, search } = useLocation();
  return (
    <output data-testid="path">
      {pathname}
      {search}
    </output>
  );
}

const SALES: Agent = agentFixture({
  id: 'abcdefghijklmnop',
  name: 'Ventas <b>LATAM</b>',
  description: 'Responde sobre el <i>pipeline</i>. <img src=x onerror=alert(1)>',
  category: 'Comercial',
  icon: 'Zap',
  color: 3,
  model: 'model-a',
  allowed_models: ['model-a', 'model-b'],
  tools: ['crm.search', 'crm.get', 'cost-explorer.get_cost_and_usage'],
});
const RETIRED: Agent = agentFixture({ id: 'qrstuvwxyz234567', name: 'Viejo', status: 'retired' });
const CONVERSATION_ID = '01J0000000000000000000000';
const conversationOf = (agentId: string) =>
  ({
    conversation_id: CONVERSATION_ID,
    title: 'Gasto',
    agent_id: agentId,
    messages: [],
  }) as unknown as Awaited<ReturnType<ApiClient['getConversation']>>;

function topbar(): HTMLElement {
  const header = document.querySelector<HTMLElement>('header.topbar');
  if (!header) throw new Error('no topbar');
  return header;
}

describe('ChatPage', () => {
  it('shows the header like the design, with unavailable controls as "Próximamente"', () => {
    renderChat(streamingApi([]).api);
    // Design (closing round): no «En línea» dot, like the hero; the API has no such status.
    expect(topbar()).not.toHaveTextContent('En línea');
    expect(topbar().querySelector('.dot')).toBeNull();
    for (const label of [
      'Costo de la conversación',
      'Skills y tools disponibles',
      'Más opciones',
      'Adjuntar archivos',
      'Skill',
      'Comandos con /',
    ]) {
      expect(screen.getByText(`${label}, próximamente`)).toBeInTheDocument();
    }
    expect(screen.getByRole('textbox', { name: 'Mensaje a FinOps' })).toHaveAttribute(
      'placeholder',
      'Mensaje a FinOps…',
    );
  });

  it('ends the header with one gear (admins only) and one "+" (v11)', () => {
    renderChat(streamingApi([]).api, true);
    const header = within(topbar());
    expect(header.getAllByRole('button', { name: 'Ajustes' })).toHaveLength(1);
    expect(header.getAllByRole('button', { name: 'Nueva conversación' })).toHaveLength(1);
  });

  it('has no gear for non-admins', () => {
    renderChat(streamingApi([]).api);
    const header = within(topbar());
    expect(header.queryByRole('button', { name: 'Ajustes' })).toBeNull();
    expect(header.getByRole('button', { name: 'Nueva conversación' })).toBeInTheDocument();
  });

  it('opens the history in a "Historial" drawer below 1100px (v12)', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 1100px)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    try {
      const user = userEvent.setup();
      renderChat(streamingApi([]).api);
      const open = within(topbar()).getByRole('button', { name: 'Conversaciones' });
      expect(open).toHaveAttribute('title', 'Conversaciones');
      await user.click(open);
      const drawer = screen.getByRole('dialog', { name: 'Historial' });
      expect(within(drawer).getByRole('heading', { name: 'Conversaciones' })).toBeInTheDocument();
      await user.click(within(drawer).getByRole('button', { name: 'Cerrar' }));
      expect(screen.queryByRole('dialog', { name: 'Historial' })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('blocks messages over 4000 characters with an alert and no counter (v11)', async () => {
    const user = userEvent.setup();
    const { api, streamChat } = streamingApi([]);
    renderChat(api);
    const input = screen.getByRole('textbox', { name: 'Mensaje a FinOps' });
    await user.click(input);
    await user.paste('a'.repeat(4000));
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByRole('alert')).toBeNull();

    await user.type(input, 'b');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'El mensaje supera el máximo de 4.000 caracteres. Acórtalo para enviarlo.',
    );
    expect(input).toHaveAccessibleDescription(alert.textContent);
    expect(screen.getByRole('button', { name: /Enviar/ })).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(streamChat).not.toHaveBeenCalled();
    expect(screen.queryByText(/4001|\/ 4/)).toBeNull();
  });

  it('streams a turn, offers "Cancelar" meanwhile and opens its steps in observe mode', async () => {
    const user = userEvent.setup();
    const { api, streamChat, pending } = streamingApi([
      { type: 'conversation', conversation_id: 'c1' },
      { type: 'status', phase: 'thinking' },
      { type: 'tool', name: 'get_cost_and_usage', status: 'started' },
      { type: 'status', phase: 'tool', tool: 'get_cost_and_usage' },
    ]);
    renderChat(api);

    const observe = screen.getByRole('button', { name: 'Observar herramientas' });
    await user.click(observe);
    expect(observe).toHaveAttribute('aria-pressed', 'true');

    await user.type(screen.getByRole('textbox', { name: 'Mensaje a FinOps' }), 'Hola{Enter}');
    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: null, message: 'Hola' }),
    );
    // The visible word stays «Cancelar» (hidden when narrow, where the button is icon only).
    const cancel = await screen.findByRole('button', { name: 'Cancelar respuesta' });
    expect(cancel.querySelector('.ch-send-lbl')).toHaveTextContent('Cancelar');
    // While the turn runs, its steps are listed; the tool group comes once it ends.
    const steps = screen.getByRole('button', { name: '2 pasos' });
    expect(steps).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Consultando get_cost_and_usage')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();

    act(() => {
      pending.finish();
    });
    const send = await screen.findByRole('button', { name: 'Enviar' });
    expect(send.querySelector('.ch-send-lbl')).toHaveTextContent('Enviar');
    expect(screen.queryByRole('button', { name: /pasos/ })).toBeNull();
    expect(screen.getByRole('button', { name: /1 herramienta/ })).toBeInTheDocument();
    const answer = screen.getAllByRole('article').at(-1) as HTMLElement;
    // Once the answer is finished it can be sent again ("Reintentar").
    expect(within(answer).getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('shows the live progress of the turn until the answer arrives', async () => {
    const user = userEvent.setup();
    const { api, streamChat, pending } = streamingApi([
      { type: 'conversation', conversation_id: 'c1' },
    ]);
    renderChat(api);
    await user.type(screen.getByRole('textbox', { name: 'Mensaje a FinOps' }), 'Hola{Enter}');
    // Before the API reports anything, the design's first step.
    expect(await screen.findByText('Pensando…')).toBeInTheDocument();
    const onEvent = (streamChat.mock.calls[0] as [StreamArgs])[0].onEvent;

    act(() => {
      onEvent({ type: 'status', phase: 'tool', tool: '<b>get_cost_and_usage</b>' });
    });
    // The tool name is untrusted text: shown verbatim, never as markup.
    expect(screen.getByText('Consultando <b>get_cost_and_usage</b>…')).toBeInTheDocument();
    act(() => {
      onEvent({ type: 'status', phase: 'tool' });
    });
    expect(screen.getByText('Consultando una tool…')).toBeInTheDocument();
    act(() => {
      onEvent({ type: 'status', phase: 'tool_result' });
    });
    expect(screen.getByText('Procesando resultados…')).toBeInTheDocument();
    act(() => {
      onEvent({ type: 'status', phase: 'writing' });
    });
    expect(screen.getByText('Escribiendo…')).toBeInTheDocument();

    act(() => {
      pending.finish();
    });
    expect(await screen.findByText('USD 10')).toBeInTheDocument();
    expect(screen.queryByText('Escribiendo…')).toBeNull();
  });

  it('toasts "Respuesta completa" only once the agent has answered in full', async () => {
    const user = userEvent.setup();
    const { api, pending } = streamingApi([{ type: 'conversation', conversation_id: 'c1' }]);
    renderChat(api);
    await user.type(screen.getByRole('textbox', { name: 'Mensaje a FinOps' }), 'Hola{Enter}');
    expect(await screen.findByRole('button', { name: 'Cancelar respuesta' })).toBeInTheDocument();
    expect(screen.queryByText('Respuesta completa')).toBeNull();

    act(() => {
      pending.finish();
    });
    const title = await screen.findByText('Respuesta completa');
    const toast = title.closest('.g-toast-item') as HTMLElement;
    expect(toast).toHaveAttribute('data-tone', 'success');
    expect(toast).toHaveTextContent('FinOps terminó de responder.');
    await user.click(within(toast).getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByText('Respuesta completa')).toBeNull();
  });

  it('does not toast a stopped answer', async () => {
    const user = userEvent.setup();
    const streamChat = vi.fn(
      ({ signal }: StreamArgs) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    renderChat({ streamChat } as unknown as ApiClient);
    await user.type(screen.getByRole('textbox', { name: 'Mensaje a FinOps' }), 'Hola{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Cancelar respuesta' }));
    expect(await screen.findByText('Respuesta detenida.')).toBeInTheDocument();
    expect(screen.queryByText('Respuesta completa')).toBeNull();
  });

  it('toasts "Nueva conversación iniciada." when starting a new conversation', async () => {
    const user = userEvent.setup();
    renderChat(streamingApi([]).api);
    const history = screen.getByRole('region', { name: 'Conversaciones' });
    await user.click(within(history).getByRole('button', { name: 'Nueva conversación' }));
    const toast = screen.getByText('Nueva conversación iniciada.').closest('.g-toast-item');
    expect(toast).toHaveAttribute('data-tone', 'info');
  });

  it('retries the history from its error state', async () => {
    const user = userEvent.setup();
    const reloadConversations = vi.fn();
    renderChat(streamingApi([]).api, false, {
      session: { conversations: null, conversationsError: true, reloadConversations },
    });
    const history = screen.getByRole('region', { name: 'Conversaciones' });
    expect(within(history).getByRole('alert')).toHaveTextContent('No se pudo cargar el historial.');
    await user.click(within(history).getByRole('button', { name: 'Reintentar' }));
    expect(reloadConversations).toHaveBeenCalledOnce();
  });

  it('shows the design skeleton while a conversation loads', async () => {
    let resolve: (value: Awaited<ReturnType<ApiClient['getConversation']>>) => void = () => {};
    const getConversation = vi.fn<ApiClient['getConversation']>().mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    renderChat({ getConversation } as unknown as ApiClient, false, {
      path: '/c/01J0000000000000000000000',
    });
    // Design chat.jsx `ChatSkeleton`: role="status", aria-busy, "Cargando conversación"; two
    // question bubbles with 3 and 2 answer lines.
    const skeleton = screen.getByRole('status', { name: 'Cargando conversación' });
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton.querySelectorAll('.chat-skeleton-bubble')).toHaveLength(2);
    expect(skeleton.querySelectorAll('.chat-skeleton-line')).toHaveLength(5);

    await act(async () => {
      resolve(conversationOf('finops'));
      await Promise.resolve();
    });
    expect(screen.queryByRole('status', { name: 'Cargando conversación' })).toBeNull();
  });

  it('shows the conversation error like the design: title and two actions, no hint', async () => {
    const user = userEvent.setup();
    const getConversation = vi
      .fn<ApiClient['getConversation']>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(conversationOf('finops'));
    renderChat({ getConversation } as unknown as ApiClient, false, {
      path: '/c/01J0000000000000000000000',
    });
    const title = await screen.findByRole('heading', {
      level: 2,
      name: 'No se pudo cargar la conversación',
    });
    const error = title.closest('[role="alert"]') as HTMLElement;
    expect(error).not.toHaveTextContent('Puede que ya no exista');
    // Design chat.jsx: the Warn icon (triangle), not the Cloud one.
    expect(error.querySelector('.chat-load-error-icon path')).toHaveAttribute(
      'd',
      'M12 3 2 20h20L12 3Z',
    );
    // Design chat.jsx: a centered block of its own, not the full-page error state.
    expect(error).toHaveClass('chat-load-error');
    expect(error.querySelector('.state-title')).toBeNull();
    expect(within(error).getByRole('button', { name: 'Nueva conversación' })).toBeInTheDocument();
    await user.click(within(error).getByRole('button', { name: 'Reintentar' }));
    expect(getConversation).toHaveBeenCalledTimes(2);
  });
});

/** Design `ChatBlocked`: a status (the toast region is one too, so it is found by its class). */
function blockedState(): HTMLElement {
  const blocked = document.querySelector<HTMLElement>('.chat-blocked');
  if (!blocked) throw new Error('no blocked state on screen');
  expect(blocked).toHaveAttribute('role', 'status');
  return blocked;
}

/** The box that replaces the composer when no message can be sent. */
function composerBox(): HTMLElement {
  const box = document.querySelector<HTMLElement>('.composer-blocked-box');
  if (!box) throw new Error('the composer is not blocked');
  return box;
}

describe('ChatPage with several agents', () => {
  const two = { agents: [finopsAgent, SALES] };
  const done: ChatEvent = {
    type: 'done',
    message_id: 'm1',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
    cost_usd: '0.01',
  };
  const finishingApi = () => {
    const streamChat = vi.fn(({ onEvent }: StreamArgs) => {
      onEvent({ type: 'conversation', conversation_id: CONVERSATION_ID });
      onEvent(done);
      return Promise.resolve();
    });
    return { api: { streamChat } as unknown as ApiClient, streamChat };
  };

  it('opens a new conversation with the agent of the URL, with its texts as text', () => {
    renderChat(streamingApi([]).api, false, { path: '/?agent=abcdefghijklmnop', session: two });
    expect(screen.getByRole('heading', { level: 1, name: 'Ventas <b>LATAM</b>' })).toBeVisible();
    expect(
      screen.getByText('Responde sobre el <i>pipeline</i>. <img src=x onerror=alert(1)>'),
    ).toBeInTheDocument();
    expect(document.querySelector('.agent-hero b, .agent-hero i, .agent-hero img')).toBeNull();
    const hero = document.querySelector<HTMLElement>('.agent-hero');
    // Design "Disponible hoy": the category, with no status dot and no model.
    expect(hero).toHaveTextContent('Comercial');
    expect(hero).not.toHaveTextContent('En línea');
    expect(hero).not.toHaveTextContent('model-a');
    expect(hero?.querySelector('.dot')).toBeNull();
    expect(within(hero as HTMLElement).getByText('2 MCP servers')).toBeInTheDocument();
    expect(hero?.querySelector('.agent-avatar')).toHaveClass('mk-avatar-c3');
    // Only the release agent has capabilities and suggestions: no filler ones.
    expect(within(hero as HTMLElement).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Sugerencias' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Preguntar algo general/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Gasto del mes/ })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Mensaje a Ventas <b>LATAM</b>' })).toBeEnabled();
  });

  it('keeps the questions and capabilities of the release agent', () => {
    renderChat(streamingApi([]).api, false, { path: '/?agent=finops', session: two });
    expect(screen.getByRole('heading', { name: 'Sugerencias' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Gasto del mes/ })).toBeInTheDocument();
    expect(screen.getByText('Savings Plans')).toBeInTheDocument();
    expect(screen.getByText('1 MCP server')).toBeInTheDocument();
    const hero = document.querySelector<HTMLElement>('.agent-hero');
    expect(hero).toHaveTextContent('Agente de costos de AWS');
    expect(hero).not.toHaveTextContent('En línea');
  });

  it('sends the agent of the new conversation and the default model', async () => {
    const user = userEvent.setup();
    const { api, streamChat } = finishingApi();
    renderChat(api, false, { path: '/?agent=abcdefghijklmnop', session: two });
    await user.type(screen.getByRole('textbox'), 'hola{Enter}');
    expect(streamChat.mock.calls[0]?.[0]).toMatchObject({
      conversationId: null,
      agentId: 'abcdefghijklmnop',
      model: 'model-a',
      message: 'hola',
    });
    // The conversation now has a URL of its own and keeps its agent in the header.
    expect(await screen.findByTestId('path')).toHaveTextContent(`/c/${CONVERSATION_ID}`);
    expect(within(topbar()).getByRole('heading', { name: 'Ventas <b>LATAM</b>' })).toBeVisible();

    // The next turn names no agent: the API keeps the one of the conversation.
    await user.type(screen.getByRole('textbox'), 'otra{Enter}');
    expect(streamChat.mock.calls[1]?.[0]).toMatchObject({
      conversationId: CONVERSATION_ID,
      agentId: null,
      model: 'model-a',
    });
  });

  it('lets the user pick one of the models the agent allows', async () => {
    const user = userEvent.setup();
    const { api, streamChat } = finishingApi();
    renderChat(api, false, { path: '/?agent=abcdefghijklmnop', session: two });
    const trigger = within(topbar()).getByRole('button', { name: 'Modelo: model-a' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    const list = screen.getByRole('listbox', { name: 'Modelos permitidos' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['model-a', 'model-b']);
    expect(within(list).getByRole('option', { name: 'model-a' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByText('Solo los modelos permitidos en la versión aprobada del agente'),
    ).toBeInTheDocument();
    await user.click(within(list).getByRole('option', { name: 'model-b' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(within(topbar()).getByRole('button', { name: 'Modelo: model-b' })).toBeInTheDocument();

    await user.type(screen.getByRole('textbox'), 'hola{Enter}');
    expect(streamChat.mock.calls[0]?.[0]).toMatchObject({ model: 'model-b' });
  });

  it("closes the model list with Escape and offers only the agent's own models", async () => {
    const user = userEvent.setup();
    renderChat(streamingApi([]).api, false, { path: '/?agent=finops', session: two });
    await user.click(within(topbar()).getByRole('button', { name: 'Modelo: model-a' }));
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('goes back to the default model of the other agent when the agent changes', async () => {
    const user = userEvent.setup();
    renderChat(streamingApi([]).api, false, { path: '/?agent=abcdefghijklmnop', session: two });
    await user.click(within(topbar()).getByRole('button', { name: 'Modelo: model-a' }));
    await user.click(screen.getByRole('option', { name: 'model-b' }));
    // "+" of the header: a new conversation with the same agent keeps the choice.
    await user.click(within(topbar()).getByRole('button', { name: 'Nueva conversación' }));
    expect(screen.getByTestId('path')).toHaveTextContent('/?agent=abcdefghijklmnop');
    expect(within(topbar()).getByRole('button', { name: 'Modelo: model-b' })).toBeInTheDocument();
  });

  it('without an agent in the URL opens the one of the most recent conversation', () => {
    const conversations = [
      { conversation_id: 'c1', title: 'a', updated_at: '2026-09-30T10:00:00Z', agent_id: SALES.id },
      { conversation_id: 'c2', title: 'b', updated_at: '2026-09-29T10:00:00Z', agent_id: 'finops' },
    ];
    renderChat(streamingApi([]).api, false, { session: { ...two, conversations } });
    expect(screen.getByRole('heading', { level: 1, name: 'Ventas <b>LATAM</b>' })).toBeVisible();
  });

  it('without conversations opens the first agent the user can use', () => {
    renderChat(streamingApi([]).api, false, { session: { agents: [RETIRED, SALES] } });
    expect(screen.getByRole('heading', { level: 1, name: 'Ventas <b>LATAM</b>' })).toBeVisible();
  });

  it.each(['../me', 'Fin Ops', '%3Cscript%3E', 'x'])(
    'ignores a malformed agent in the URL (%s)',
    (value) => {
      renderChat(streamingApi([]).api, false, { path: `/?agent=${value}`, session: two });
      expect(screen.getByRole('heading', { level: 1, name: 'FinOps' })).toBeVisible();
    },
  );

  it('shows the agent of a stored conversation and sends no agent with its turns', async () => {
    const user = userEvent.setup();
    const { api, streamChat } = finishingApi();
    const getConversation = vi.fn<ApiClient['getConversation']>().mockResolvedValue({
      ...conversationOf(SALES.id),
      messages: [
        {
          message_id: 'm0',
          role: 'user',
          content: 'hola',
          created_at: '2026-09-30T10:00:00Z',
          tools: [],
        },
      ],
    });
    renderChat({ ...api, getConversation }, false, {
      path: `/c/${CONVERSATION_ID}`,
      session: two,
    });
    expect(
      await within(topbar()).findByRole('heading', { name: 'Ventas <b>LATAM</b>' }),
    ).toBeVisible();
    await user.type(screen.getByRole('textbox'), 'hola{Enter}');
    expect(streamChat.mock.calls[0]?.[0]).toMatchObject({
      conversationId: CONVERSATION_ID,
      agentId: null,
    });
  });

  it('asks the API for an agent the list does not carry', async () => {
    const call = vi.fn().mockResolvedValue(SALES);
    renderChat({ call } as unknown as ApiClient, false, {
      path: '/?agent=abcdefghijklmnop',
      session: { agents: [finopsAgent] },
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ventas <b>LATAM</b>' }),
    ).toBeVisible();
    expect(call).toHaveBeenCalledWith('getAgent', { path: { agent_id: 'abcdefghijklmnop' } });
  });

  it('says so when the agent is not available to the user, and takes no message', async () => {
    const call = vi.fn().mockRejectedValue(new Error('forbidden'));
    const streamChat = vi.fn();
    renderChat({ call, streamChat } as unknown as ApiClient, false, {
      path: '/?agent=zzzzzzzzzzzzzzzz',
      session: two,
    });
    await screen.findByRole('heading', { name: 'Este agente ya no está disponible para ti' });
    const blocked = blockedState();
    expect(
      within(blocked).getByRole('heading', { name: 'Este agente ya no está disponible para ti' }),
    ).toBeInTheDocument();
    expect(blocked).toHaveTextContent(
      'Puede que hayas perdido el acceso o que lo hayan quitado. Busca otro agente en el Marketplace.',
    );
    expect(within(blocked).getByRole('link', { name: 'Ir al Marketplace' })).toHaveAttribute(
      'href',
      '/marketplace',
    );
    // The composer is replaced by a disabled box (design chat.jsx).
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();
    const box = composerBox();
    expect(box).toHaveTextContent('No puedes enviar mensajes a este agente.');
    // The link stays operable: the box is not `aria-disabled`.
    expect(box.closest('[aria-disabled]')).toBeNull();
    expect(within(box).getByRole('link', { name: 'Ir al Marketplace' })).toHaveAttribute(
      'href',
      '/marketplace',
    );
    expect(streamChat).not.toHaveBeenCalled();
  });

  it('says so when the user has no agents', () => {
    renderChat(streamingApi([]).api, false, { session: { agents: [] } });
    const blocked = blockedState();
    expect(
      within(blocked).getByRole('heading', { name: 'Todavía no tienes agentes disponibles' }),
    ).toBeInTheDocument();
    expect(blocked).toHaveTextContent(
      'Los agentes que puedes usar dependen de tus grupos. Revisa el Marketplace o pide acceso a un administrador.',
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(composerBox()).toHaveTextContent('Necesitas un agente para conversar.');
  });

  it('waits for the agents before choosing one', () => {
    renderChat(streamingApi([]).api, false, { session: { agents: null } });
    expect(screen.getByRole('status', { name: 'Cargando conversación' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers to load the agents again when the list failed', async () => {
    const user = userEvent.setup();
    const reloadAgents = vi.fn();
    renderChat(streamingApi([]).api, false, {
      session: { agents: null, agentsError: true, reloadAgents },
    });
    const alert = screen.getByRole('alert');
    // A failed list is not "you have no agents".
    expect(alert).toHaveTextContent('No se pudieron cargar tus agentes');
    expect(screen.queryByText('Todavía no tienes agentes disponibles')).toBeNull();
    expect(alert).toHaveTextContent('No se pudo completar la acción. Inténtalo de nuevo.');
    // Design: no composer in this state, and «Reintentar» is the only action.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(within(alert).queryByRole('link')).toBeNull();
    await user.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    expect(reloadAgents).toHaveBeenCalledOnce();
  });

  it('does not take messages for a retired agent', () => {
    renderChat(streamingApi([]).api, false, {
      path: '/?agent=qrstuvwxyz234567',
      session: { agents: [finopsAgent, RETIRED] },
    });
    const blocked = blockedState();
    expect(
      within(blocked).getByRole('heading', { name: 'Este agente fue retirado' }),
    ).toBeInTheDocument();
    expect(blocked).toHaveTextContent(
      'Sus conversaciones se conservan, pero no se pueden empezar nuevas. Busca otro agente en el Marketplace.',
    );
    expect(within(topbar()).getByText('Retirado')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(composerBox()).toHaveTextContent('No se pueden enviar mensajes a un agente retirado.');
  });

  it('keeps the history of a retired agent and only blocks the composer', async () => {
    const getConversation = vi.fn<ApiClient['getConversation']>().mockResolvedValue({
      ...conversationOf(RETIRED.id),
      messages: [
        {
          message_id: 'm0',
          role: 'user',
          content: 'pregunta vieja',
          created_at: '2026-09-30T10:00:00Z',
          tools: [],
        },
      ],
    });
    renderChat({ getConversation } as unknown as ApiClient, false, {
      path: `/c/${CONVERSATION_ID}`,
      session: { agents: [finopsAgent, RETIRED] },
    });
    expect(await screen.findByText('pregunta vieja')).toBeInTheDocument();
    expect(document.querySelector('.chat-blocked')).toBeNull();
    expect(composerBox()).toHaveTextContent('No se pueden enviar mensajes a un agente retirado.');
  });

  it('warns that the agent answers without the tools of a disabled MCP', async () => {
    const limited = agentFixture({
      id: 'abcdefghijklmnop',
      name: 'Ventas <b>LATAM</b>',
      unavailable_tools: ['aws-billing.get_cost'],
    });
    const getConversation = vi.fn<ApiClient['getConversation']>().mockResolvedValue({
      ...conversationOf(limited.id),
      messages: [
        {
          message_id: 'm0',
          role: 'user',
          content: 'hola',
          created_at: '2026-09-30T10:00:00Z',
          tools: [],
        },
      ],
    });
    renderChat({ getConversation } as unknown as ApiClient, false, {
      path: `/c/${CONVERSATION_ID}`,
      session: { agents: [finopsAgent, limited] },
    });
    const notice = await screen.findByText(
      'Algunas tools de Ventas <b>LATAM</b> no están disponibles ahora porque se deshabilitó su MCP. Responderá sin ellas hasta que se vuelva a habilitar.',
    );
    expect(notice.closest('[role="status"]')).toHaveClass('mc-alert', 'amber');
    expect(document.querySelector('.chat-notice b')).toBeNull();
    // The composer still works: the agent answers without those tools.
    expect(screen.getByRole('textbox')).toBeEnabled();
  });

  it('shows no tools notice when every tool of the agent is available', async () => {
    const getConversation = vi.fn<ApiClient['getConversation']>().mockResolvedValue({
      ...conversationOf(SALES.id),
      messages: [
        {
          message_id: 'm0',
          role: 'user',
          content: 'hola',
          created_at: '2026-09-30T10:00:00Z',
          tools: [],
        },
      ],
    });
    renderChat({ getConversation } as unknown as ApiClient, false, {
      path: `/c/${CONVERSATION_ID}`,
      session: two,
    });
    expect(await screen.findByText('hola')).toBeInTheDocument();
    expect(document.querySelector('.chat-notice')).toBeNull();
  });
});
