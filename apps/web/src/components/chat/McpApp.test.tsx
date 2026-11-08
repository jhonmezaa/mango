import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppRequest } from '@mango/ui-sandbox/protocol';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { AppHandlers } from '../../sandbox/sandboxHost';
import { sessionValue, testConfig } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { McpApp } from './McpApp';

const opened = vi.hoisted(() => ({
  requests: [] as AppRequest[],
  handlers: [] as AppHandlers[],
  modes: [] as string[],
  destroyed: 0,
  fail: null as Error | null,
}));

vi.mock('../../sandbox/sandboxHost', () => ({
  openSandbox: vi.fn(({ container }: { container: HTMLElement }) => {
    container.append(document.createElement('iframe'));
    return Promise.resolve({
      startApp: (request: AppRequest, handlers: AppHandlers) => {
        opened.requests.push(request);
        opened.handlers.push(handlers);
        return opened.fail ? Promise.reject(opened.fail) : Promise.resolve();
      },
      setAppDisplayMode: (mode: string) => {
        opened.modes.push(mode);
        return Promise.resolve();
      },
      destroy: () => {
        opened.destroyed += 1;
      },
    });
  }),
}));

const CONVERSATION = 'c'.repeat(32);
const APP = { appId: 'a'.repeat(32), registrationId: 'abcdefghij23', tool: 'wit_work_item' };
const HTML = '<p>app</p>';

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function detail(html = HTML) {
  return {
    app_id: APP.appId,
    registration_id: APP.registrationId,
    service: 'Azure DevOps',
    tool: APP.tool,
    html,
    html_sha256: await sha256(HTML),
    tool_input: { action: 'my' },
    tool_result: { content: [{ type: 'text', text: '[1]' }], is_error: false },
    calls_used: 2,
    calls_limit: 20,
  };
}

function setup(call: ReturnType<typeof vi.fn>) {
  const api = { call } as unknown as ApiClient;
  return render(
    <TestProviders
      session={sessionValue({
        api,
        config: { ...testConfig, sandboxOrigin: 'https://sandbox.example.com' },
      })}
    >
      <McpApp conversationId={CONVERSATION} app={APP} />
    </TestProviders>,
  );
}

beforeEach(() => {
  opened.requests = [];
  opened.handlers = [];
  opened.modes = [];
  opened.destroyed = 0;
  opened.fail = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('an MCP App in the chat (D125, design round 41)', () => {
  it('draws the label of origin outside the frame and starts the app with its data', async () => {
    const call = vi.fn(async (name: string) => (name === 'getMcpApp' ? detail() : null));
    setup(call);
    expect(screen.getByText('Cargando la app…')).toBeInTheDocument();
    await screen.findByText(/2 de 20 llamadas en este turno/);
    expect(screen.getByText('app de Azure DevOps')).toBeInTheDocument();
    expect(screen.getByText('wit_work_item')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Solo lectura\. Cada llamada pasa por Mango con tus permisos y tu presupuesto/,
      ),
    ).toBeInTheDocument();
    expect(opened.requests).toEqual([
      {
        html: HTML,
        toolInput: { action: 'my' },
        toolResult: { content: [{ type: 'text', text: '[1]' }], isError: false },
        displayMode: 'inline',
      },
    ]);
  });

  it('does not draw an HTML that is not the one its profile pins (TM-UI8)', async () => {
    setup(vi.fn(() => detail('<p>evil</p>')));
    await screen.findByText('La app no arrancó a tiempo.');
    expect(opened.requests).toEqual([]);
  });

  it('says why Mango did not make a call of the app', async () => {
    const call = vi.fn(async (name: string) => {
      if (name === 'getMcpApp') return detail();
      throw new ApiError(402, 'budget_exceeded', 'no');
    });
    setup(call);
    await screen.findByText(/2 de 20 llamadas/);
    const handlers = opened.handlers[0];
    if (!handlers) throw new Error('no app');
    await act(async () => {
      await expect(handlers.callTool('wit_work_item', { id: 1 })).rejects.toThrow(
        'sin presupuesto: tu presupuesto del mes se agotó',
      );
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'La app pidió wit_work_item y Mango no la hizo: sin presupuesto: tu presupuesto del mes se agotó.',
    );
    expect(call).toHaveBeenCalledWith('callMcpAppTool', {
      path: { conversation_id: CONVERSATION, app_id: APP.appId },
      body: { name: 'wit_work_item', arguments: { id: 1 } },
    });
  });

  it('asks the person to connect when a call needs their account', async () => {
    const call = vi.fn(async (name: string) => {
      if (name === 'getMcpApp') return detail();
      throw new ApiError(409, 'consent_required', 'connect');
    });
    setup(call);
    await screen.findByText(/2 de 20 llamadas/);
    await act(async () => {
      await opened.handlers[0]?.callTool('wit_work_item', {}).catch(() => undefined);
    });
    expect(
      screen.getByText('Conecta tu cuenta de Azure DevOps para usar esta app'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Conectar' })).toBeInTheDocument();
  });

  it('grants the display modes and keeps the app when it moves', async () => {
    const user = userEvent.setup();
    setup(vi.fn(() => detail()));
    await screen.findByText(/2 de 20 llamadas/);
    await user.click(screen.getByRole('button', { name: 'Pantalla completa' }));
    expect(screen.getByText('La app está en pantalla completa.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'app de Azure DevOps' })).toBeInTheDocument();
    expect(opened.modes).toEqual(['fullscreen']);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    // The app asks for a mode: Mango grants it.
    act(() => {
      expect(opened.handlers[0]?.requestDisplayMode('pip')).toBe('pip');
    });
    expect(screen.getByText('La app está en una ventana flotante.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Traer aquí' }));
    // The frame was never re-created by moving it.
    expect(opened.requests).toHaveLength(1);
    expect(opened.destroyed).toBe(0);
  });

  it('closes and opens again, and offers to retry an app that did not start', async () => {
    const user = userEvent.setup();
    opened.fail = new Error('The app took too long to initialize.');
    setup(vi.fn(() => detail()));
    await screen.findByText('La app no arrancó a tiempo.');
    opened.fail = null;
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    await screen.findByText(/2 de 20 llamadas/);
    await user.click(screen.getByRole('button', { name: 'Cerrar la app' }));
    expect(screen.getByText('Cerraste la app.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Abrir de nuevo' }));
    await waitFor(() => { expect(opened.requests).toHaveLength(3); });
  });

  it('draws nothing when the release no longer curates the app', async () => {
    const { container } = setup(
      vi.fn(() => Promise.reject(new ApiError(404, 'app_unavailable', 'x'))),
    );
    await waitFor(() => { expect(container.querySelector('.ap-card')).toBeNull(); });
  });
});
