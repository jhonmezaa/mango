import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { DisplayMessage } from '../../hooks/chatState';
import { ChatMessage } from './ChatMessage';

type Props = ComponentProps<typeof ChatMessage>;

function renderMessage(message: DisplayMessage, props: Partial<Props> = {}) {
  const onSend = props.onSend ?? vi.fn();
  const result = render(
    <MemoryRouter>
      <ChatMessage
        message={message}
        observe={false}
        isAdmin={false}
        onSend={onSend}
        resendText={null}
        retryText={null}
        {...props}
      />
    </MemoryRouter>,
  );
  return { ...result, onSend };
}

const streaming = (tools: DisplayMessage['tools']): DisplayMessage => ({
  id: 'a',
  role: 'assistant',
  content: '',
  status: 'streaming',
  tools,
});

describe('ChatMessage: tool group', () => {
  it('collapses the turn tool calls into "N herramientas · X s"', async () => {
    const user = userEvent.setup();
    renderMessage({
      id: 'a',
      role: 'assistant',
      content: 'Listo',
      status: 'done',
      tools: [
        { name: 'get_cost_and_usage', status: 'completed', startedAt: 0, durationMs: 820 },
        { name: 'get_cost_forecast', status: 'completed', startedAt: 0, durationMs: 1120 },
      ],
    });
    const head = screen.getByRole('button', { name: /2 herramientas/ });
    expect(head).toHaveTextContent('2 herramientas· 1,9 s');
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('get_cost_and_usage')).toBeNull();

    await user.click(head);
    const list = screen.getByRole('list', { name: 'Herramientas del agente' });
    expect(within(list).getByText('get_cost_and_usage')).toBeInTheDocument();
    expect(within(list).getByText('820 ms')).toBeInTheDocument();

    // Parameters are not in the SSE event: the row expands to "Próximamente".
    await user.click(within(list).getAllByRole('button')[0] as HTMLElement);
    expect(screen.getByText('Parámetros de la tool, próximamente')).toBeInTheDocument();
  });

  it('omits the total for loaded history and renders tool names as text', () => {
    renderMessage({
      id: 'a',
      role: 'assistant',
      content: 'x',
      status: 'done',
      tools: [{ name: '<img src=x>', status: 'completed' }],
    });
    const head = screen.getByRole('button', { name: /1 herramienta/ });
    expect(head.textContent).not.toContain(' s');
  });

  it('shows the total only when every tool call was measured (design ToolGroup)', () => {
    renderMessage({
      id: 'a',
      role: 'assistant',
      content: 'x',
      status: 'done',
      tools: [
        { name: 'get_cost_and_usage', status: 'completed', startedAt: 0, durationMs: 820 },
        { name: 'get_cost_forecast', status: 'interrupted', startedAt: 0 },
      ],
    });
    const head = screen.getByRole('button', { name: /2 herramientas/ });
    expect(head.querySelector('.tool-group-time')).toBeNull();
  });

  it('marks a tool that failed', async () => {
    const user = userEvent.setup();
    renderMessage({
      id: 'a',
      role: 'assistant',
      content: 'x',
      status: 'done',
      tools: [
        { name: 'get_cost_and_usage', status: 'completed' },
        { name: 'get_rightsizing_recommendations', status: 'error' },
      ],
    });
    await user.click(screen.getByRole('button', { name: /2 herramientas/ }));
    const rows = within(screen.getByRole('list', { name: 'Herramientas del agente' })).getAllByRole(
      'listitem',
    );
    expect(within(rows[0] as HTMLElement).queryByText('Falló', { selector: '.badge' })).toBeNull();
    expect(
      within(rows[1] as HTMLElement).getByText('Falló', { selector: '.badge' }),
    ).toBeInTheDocument();
  });
});

describe('ChatMessage: progress of a turn in flight (design chat.jsx StreamingMessage)', () => {
  const steps: NonNullable<DisplayMessage['steps']> = [
    { id: 0, kind: 'thinking', status: 'ok' },
    { id: 1, kind: 'tool', tool: '<b>get_cost_and_usage</b>', status: 'ok' },
    { id: 2, kind: 'tool', tool: 'get_rightsizing_recommendations', status: 'failed' },
    { id: 3, kind: 'tool_result', status: 'running' },
  ];

  it('shows «Pensando…» before the API reports anything, and no steps for a single one', () => {
    renderMessage({ ...streaming([]), steps: [{ id: 0, kind: 'thinking', status: 'running' }] });
    expect(screen.getByRole('status')).toHaveTextContent('Pensando…');
    expect(screen.queryByRole('button', { name: /paso/ })).toBeNull();
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  it('lists the steps of the turn folded, with how many failed, and names as text', async () => {
    const user = userEvent.setup();
    const { container } = renderMessage({
      ...streaming([]),
      steps,
      progress: { phase: 'tool_result' },
    });
    // While the turn runs the steps replace the tool group.
    expect(screen.queryByRole('button', { name: /herramienta/ })).toBeNull();
    const head = screen.getByRole('button', { name: '4 pasos · 1 con error' });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    await user.click(head);
    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual([
      'ListoPensó',
      'ListoConsultó <b>get_cost_and_usage</b>',
      'FallóFalló get_rightsizing_recommendations',
      'En cursoProcesó resultados',
    ]);
    expect(container.querySelector('b')).toBeNull();
  });

  it('opens the steps in observe mode, with the LIVE marker', () => {
    renderMessage(
      { ...streaming([]), steps, progress: { phase: 'tool_result' } },
      { observe: true },
    );
    expect(screen.getByRole('button', { name: /4 pasos/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('keeps the phase under the partial text while the agent is not writing', () => {
    const { container, rerender } = renderMessage({
      ...streaming([{ name: 'get_cost_forecast', status: 'started' }]),
      content: 'Primera parte.',
      progress: { phase: 'tool', tool: 'get_cost_forecast' },
    });
    expect(screen.getByText('Consultando get_cost_forecast…')).toBeInTheDocument();
    expect(container.querySelector('.md-streaming')).toBeNull();

    rerender(
      <MemoryRouter>
        <ChatMessage
          message={{
            ...streaming([]),
            content: 'Primera parte.',
            progress: { phase: 'writing' },
          }}
          observe={false}
          isAdmin={false}
          onSend={vi.fn()}
          resendText={null}
          retryText={null}
        />
      </MemoryRouter>,
    );
    // While it writes, the cursor replaces the phase line (kept for screen readers).
    expect(container.querySelector('.ch-phase')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Escribiendo…');
  });

  it('counts the tools that run at once and falls back when the tool has no name', () => {
    const { rerender } = renderMessage({
      ...streaming([
        { name: 'get_cost_and_usage', status: 'started' },
        { name: 'get_rightsizing_recommendations', status: 'started' },
      ]),
      progress: { phase: 'tool', tool: 'get_cost_and_usage' },
    });
    expect(screen.getByText('Consultando 2 tools…')).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <ChatMessage
          message={{ ...streaming([]), progress: { phase: 'tool' } }}
          observe={false}
          isAdmin={false}
          onSend={vi.fn()}
          resendText={null}
          retryText={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Consultando una tool…')).toBeInTheDocument();
  });

  it('says that the guardrail cut the answer, under what was written', () => {
    renderMessage({
      id: 'a',
      role: 'assistant',
      content: 'Lo que alcanzó a escribir',
      status: 'done',
      tools: [],
      guardrail: true,
    });
    expect(
      screen.getByText(/La respuesta se cortó porque infringía una regla/),
    ).toBeInTheDocument();
  });
});

describe('ChatMessage: user and agent actions', () => {
  it('shows user text verbatim with its time, copy and edit as "Próximamente"', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const { container } = renderMessage({
      id: 'u',
      role: 'user',
      content: '**no markdown** <b>x</b>',
      status: 'done',
      tools: [],
      createdAt: '2026-09-30T12:03:00',
    });
    expect(screen.getByText('**no markdown** <b>x</b>')).toBeInTheDocument();
    expect(container.querySelector('img, b, strong')).toBeNull();
    expect(screen.getByText('12:03')).toBeInTheDocument();
    expect(screen.getByText('Editar mensaje, próximamente')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copiar mensaje' }));
    expect(writeText).toHaveBeenCalledWith('**no markdown** <b>x</b>');
    expect(await screen.findByRole('button', { name: 'Copiado' })).toBeInTheDocument();
  });

  it('offers copy, feedback as "Próximamente" and resend on finished answers', async () => {
    const user = userEvent.setup();
    const { onSend } = renderMessage(
      { id: 'a', role: 'assistant', content: 'Respuesta', status: 'done', tools: [] },
      { resendText: '¿Cuánto gastamos?' },
    );
    expect(screen.getByRole('button', { name: 'Copiar respuesta' })).toBeInTheDocument();
    expect(screen.getByText('Útil / Mejorable, próximamente')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onSend).toHaveBeenCalledWith('¿Cuánto gastamos?');
  });

  it('does nothing (and does not throw) when the clipboard API is missing', async () => {
    const user = userEvent.setup();
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    // userEvent.setup() installs a clipboard stub: remove it to simulate an insecure context.
    Reflect.deleteProperty(navigator, 'clipboard');
    const onError = vi.fn();
    window.addEventListener('error', onError);
    try {
      renderMessage({
        id: 'a',
        role: 'assistant',
        content: 'Respuesta',
        status: 'done',
        tools: [],
      });
      await user.click(screen.getByRole('button', { name: 'Copiar respuesta' }));
      expect(screen.getByRole('button', { name: 'Copiar respuesta' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Copiado' })).toBeNull();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('error', onError);
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
    }
  });

  it('keeps a cancelled answer as is, followed by the "Respuesta detenida." note', () => {
    const { container } = renderMessage({
      id: 'a',
      role: 'assistant',
      content: 'Texto parcial',
      status: 'stopped',
      tools: [],
    });
    const article = container.querySelector('article');
    expect(article).toHaveTextContent('Texto parcial');
    expect(article).not.toHaveTextContent('Respuesta detenida.');
    const note = screen.getByText('Respuesta detenida.');
    expect(note).toHaveClass('msg-stopped');
    expect(note.querySelector('svg')).not.toBeNull();
  });

  it('shows only the note when nothing was received before cancelling', () => {
    const { container } = renderMessage({
      id: 'a',
      role: 'assistant',
      content: '',
      status: 'stopped',
      tools: [],
    });
    expect(container.querySelector('article')).toBeNull();
    expect(screen.getByText('Respuesta detenida.')).toBeInTheDocument();
  });

  it('has no actions while the answer streams', () => {
    renderMessage({
      id: 'a',
      role: 'assistant',
      content: 'Parcial',
      status: 'streaming',
      tools: [],
    });
    expect(screen.queryByRole('button', { name: 'Copiar respuesta' })).toBeNull();
  });
});

describe('ChatMessage: error states', () => {
  const budget: DisplayMessage = {
    id: 'a',
    role: 'assistant',
    content: '',
    status: 'error',
    errorKey: 'errors.budget_exceeded',
    tools: [],
  };

  it('shows budget_exceeded as a system notice without retry or budget link for users', () => {
    renderMessage(budget, { retryText: 'x' });
    expect(screen.getByRole('alert')).toHaveTextContent('Aviso del sistema');
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Ver presupuesto' })).toBeNull();
  });

  it('links admins to Presupuestos from the budget notice', () => {
    renderMessage(budget, { isAdmin: true });
    expect(screen.getByRole('link', { name: 'Ver presupuesto' })).toHaveAttribute(
      'href',
      '/budgets',
    );
  });

  it('offers retry on retryable errors when the page provides the question', async () => {
    const user = userEvent.setup();
    const { onSend } = renderMessage(
      {
        id: 'a',
        role: 'assistant',
        content: '',
        status: 'error',
        errorKey: 'errors.upstream_error',
        tools: [],
      },
      { retryText: 'hola' },
    );
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onSend).toHaveBeenCalledWith('hola');
  });
});
