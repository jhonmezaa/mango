import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation, useParams } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { agentFixture, baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { clearRecentSearches, recentSearches, type SearchAnswer, type SearchResult } from './model';
import { focusMessageFrom } from '../chatFocus';
import { SearchPage } from './SearchPage';

const CONV_A = 'a'.repeat(32);
const CONV_B = 'b'.repeat(32);
const XSS = '<img src=x onerror=alert(1)>';
const security = agentFixture({ id: 'security', name: 'Security', icon: 'Shield', color: 2 });

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    conversation_id: CONV_A,
    title: 'Gasto de EC2',
    agent_id: 'finops',
    updated_at: new Date().toISOString(),
    hits: [
      {
        kind: 'user',
        message_id: 'm1',
        pre: false,
        post: true,
        parts: [
          { text: '¿Cuánto gastamos en ', hit: false },
          { text: 'EC2', hit: true },
        ],
      },
    ],
    ...overrides,
  };
}

function answer(overrides: Partial<SearchAnswer> = {}): SearchAnswer {
  return {
    results: [result()],
    conversations_read: 12,
    capped: false,
    truncated: false,
    ...overrides,
  };
}

function Chat() {
  const { conversationId } = useParams();
  const state: unknown = useLocation().state;
  return (
    <p>
      chat {conversationId} at {focusMessageFrom(state) ?? 'start'}
    </p>
  );
}

function renderPage(call: ReturnType<typeof vi.fn>, overrides = {}) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders
      session={sessionValue({ api, agents: [agentFixture(), security], ...overrides })}
      path="/search"
    >
      <Routes>
        <Route path="search" element={<SearchPage />} />
        <Route path="c/:conversationId" element={<Chat />} />
      </Routes>
    </TestProviders>,
  );
}

const searchBox = () => screen.getByRole('combobox', { name: 'Buscar en conversaciones' });

const answering = (data: SearchAnswer) => vi.fn(() => Promise.resolve(data));

afterEach(() => {
  clearRecentSearches(baseMe.user_id);
});

describe('SearchPage', () => {
  it('searches after a pause and marks the terms as text', async () => {
    const user = userEvent.setup();
    const hit = result({
      title: XSS,
      hits: [
        {
          kind: 'agent',
          message_id: 'm2',
          pre: true,
          post: false,
          parts: [
            { text: XSS, hit: false },
            { text: 'EC2', hit: true },
          ],
        },
      ],
    });
    const call = answering(answer({ results: [hit] }));
    renderPage(call);
    const input = screen.getByRole('combobox', { name: 'Buscar en conversaciones' });
    expect(input).toHaveFocus();
    await user.type(input, 'ec2');
    expect(await screen.findByText('Agente')).toBeInTheDocument();
    // One request per pause, not per key.
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      'searchConversations',
      {
        body: {
          q: 'ec2',
          kind: 'all',
          when: 'all',
          sort: 'relevance',
          utc_offset_minutes: -new Date().getTimezoneOffset(),
        },
      },
      expect.anything(),
    );
    const mark = document.querySelector('mark.sr-mark');
    expect(mark?.textContent).toBe('EC2');
    // Stored text is untrusted: rendered as text, never as markup.
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getAllByText(XSS, { exact: false }).length).toBeGreaterThan(0);
    expect(
      screen.getByText('coincidencia', { exact: false, selector: '.sr-count-n' }),
    ).toBeInTheDocument();
    // One hidden status says it (design round 35).
    expect(screen.getByRole('status')).toHaveTextContent('1 coincidencia en 1 conversación');
  });

  it('sends the filters as closed values and clears them', async () => {
    const user = userEvent.setup();
    const call = answering(answer({ results: [] }));
    renderPage(call);
    await user.type(searchBox(), 'buckets');
    await screen.findByText('Sin resultados para “buckets”');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agente' }), 'security');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Fecha' }), 'today');
    await user.click(screen.getByRole('button', { name: 'Herramientas' }));
    await screen.findByText('Prueba quitando algún filtro.');
    await waitFor(() => {
      expect(call).toHaveBeenCalledTimes(2);
    });
    const last = call.mock.lastCall as unknown as [string, { body: Record<string, unknown> }];
    expect(last[0]).toBe('searchConversations');
    expect(last[1].body).toMatchObject({ agent: 'security', when: 'today', kind: 'tool' });
    await user.click(screen.getByRole('button', { name: 'Quitar filtros' }));
    expect(await screen.findByText(/Revisa la ortografía/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Todo' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('moves with the arrows and opens the conversation with Enter', async () => {
    const user = userEvent.setup();
    renderPage(
      answering(
        answer({ results: [result(), result({ conversation_id: CONV_B, title: 'Otra' })] }),
      ),
    );
    const input = searchBox();
    await user.type(input, 'ec2');
    const list = await screen.findByRole('listbox', { name: 'Buscar conversaciones' });
    const options = within(list).getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', 'sr-1');
    await user.keyboard('{Enter}');
    expect(await screen.findByText(`chat ${CONV_B} at m1`)).toBeInTheDocument();
    // Remembered in memory only: nothing in Web Storage.
    expect(recentSearches(baseMe.user_id)).toEqual(['ec2']);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('shows the recent searches and the recent conversations when idle', async () => {
    const user = userEvent.setup();
    renderPage(answering(answer()), {
      conversations: [
        {
          conversation_id: CONV_A,
          title: 'Gasto de EC2',
          agent_id: 'finops',
          updated_at: new Date().toISOString(),
        },
      ],
    });
    const recent = screen.getByText('conversaciones recientes').closest('section');
    if (!recent) throw new Error('recent conversations');
    expect(within(recent).getByText('FinOps')).toBeInTheDocument();
    // «Prueba con» is hidden: there is no source without reading content (D103).
    expect(screen.queryByText('prueba con')).not.toBeInTheDocument();
    await user.type(searchBox(), 'ec2');
    await screen.findByText('Tú');
    // Leaving the input with results remembers the search (design).
    await user.click(screen.getByRole('button', { name: 'Borrar búsqueda' }));
    expect(screen.getByText('búsquedas recientes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Borrar' }));
    expect(screen.queryByText('búsquedas recientes')).not.toBeInTheDocument();
    const again = screen.getByText('conversaciones recientes').closest('section');
    if (!again) throw new Error('recent conversations');
    await user.click(within(again).getByRole('button', { name: /Gasto de EC2/ }));
    expect(await screen.findByText(`chat ${CONV_A} at start`)).toBeInTheDocument();
  });

  it('focuses the search with the slash key and clears it with Escape', async () => {
    const user = userEvent.setup();
    renderPage(answering(answer()));
    const input = searchBox();
    input.blur();
    await user.keyboard('/');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('');
    await user.type(input, 'ec2');
    await user.keyboard('{Escape}');
    expect(input).toHaveValue('');
  });

  it('says when the search did not cover everything', async () => {
    const user = userEvent.setup();
    renderPage(answering(answer({ capped: true, conversations_read: 200 })));
    await user.type(searchBox(), 'ec2');
    expect(
      await screen.findByText(
        'Buscamos en tus 200 conversaciones más recientes; las más antiguas no se revisaron.',
      ),
    ).toBeInTheDocument();
  });

  it('expands more than three hits', async () => {
    const user = userEvent.setup();
    const hits = Array.from({ length: 5 }, (_, i) => ({
      kind: 'user' as const,
      message_id: `m${String(i)}`,
      pre: false,
      post: false,
      parts: [{ text: `EC2 ${String(i)}`, hit: false }],
    }));
    renderPage(answering(answer({ results: [result({ hits })] })));
    await user.type(searchBox(), 'ec2');
    await user.click(await screen.findByRole('button', { name: 'Ver 2 más' }));
    expect(screen.getByText('EC2 4')).toBeInTheDocument();
    expect(screen.getByText('5', { selector: 'b' })).toBeInTheDocument();
  });

  it('waits out a 429 before «Reintentar»', async () => {
    const user = userEvent.setup();
    const call = vi.fn(() =>
      Promise.reject(new ApiError(429, 'rate_limited', 'too many requests', 30)),
    );
    renderPage(call);
    await user.type(searchBox(), 'ec2');
    // Design round 35: its own block, with the common wait line and countdown.
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Demasiadas solicitudes')).toBeInTheDocument();
    expect(alert).toHaveTextContent(
      'Hiciste muchas búsquedas seguidas. Puedes volver a intentarlo en unos segundos.',
    );
    expect(within(alert).getByRole('button', { name: /Reintentar en/ })).toBeDisabled();
    // While it counts down, changing the query sends nothing.
    await user.type(searchBox(), ' s3');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(call).toHaveBeenCalledTimes(1);
    expect(
      within(screen.getByRole('alert')).getByText('Demasiadas solicitudes'),
    ).toBeInTheDocument();
  });

  it('opens a hit at its message and the card at its first message hit', async () => {
    const user = userEvent.setup();
    const hits = [
      {
        kind: 'title' as const,
        message_id: null,
        pre: false,
        post: false,
        parts: [{ text: 'EC2', hit: true }],
      },
      {
        kind: 'user' as const,
        message_id: 'm1',
        pre: false,
        post: false,
        parts: [{ text: 'EC2 uno', hit: true }],
      },
      {
        kind: 'agent' as const,
        message_id: 'm2',
        pre: false,
        post: false,
        parts: [{ text: 'EC2 dos', hit: true }],
      },
    ];
    renderPage(answering(answer({ results: [result({ hits })] })));
    await user.type(searchBox(), 'ec2');
    await user.click(await screen.findByRole('button', { name: /EC2 dos/ }));
    expect(await screen.findByText(`chat ${CONV_A} at m2`)).toBeInTheDocument();
    // The address carries no message id (owner's choice): it goes in the navigation state.
    expect(window.location.search).toBe('');
  });

  it('opens with Enter at the first hit that is not the title', async () => {
    const user = userEvent.setup();
    renderPage(answering(answer()));
    await user.type(searchBox(), 'ec2');
    await screen.findByText('Tú');
    await user.keyboard('{Enter}');
    expect(await screen.findByText(`chat ${CONV_A} at m1`)).toBeInTheDocument();
    expect(screen.queryByText('abre en la coincidencia', { exact: false })).toBeNull();
  });

  it('opens a result with only a title hit from the start', async () => {
    const user = userEvent.setup();
    const hits = [
      {
        kind: 'title' as const,
        message_id: null,
        pre: false,
        post: false,
        parts: [{ text: 'EC2', hit: true }],
      },
    ];
    renderPage(answering(answer({ results: [result({ hits })] })));
    await user.type(searchBox(), 'ec2');
    await screen.findByText('Título');
    await user.keyboard('{Enter}');
    expect(await screen.findByText(`chat ${CONV_A} at start`)).toBeInTheDocument();
  });

  it('shows both cap lines in order, and only the read line without results', async () => {
    const user = userEvent.setup();
    const call = vi
      .fn()
      .mockResolvedValueOnce(answer({ capped: true, truncated: true, conversations_read: 200 }))
      .mockResolvedValue(
        answer({ results: [], capped: true, truncated: true, conversations_read: 200 }),
      );
    renderPage(call);
    await user.type(searchBox(), 'ec2');
    const read =
      'Buscamos en tus 200 conversaciones más recientes; las más antiguas no se revisaron.';
    const shown =
      'Se muestran las 1 conversaciones con más coincidencias; afina la búsqueda para ver otras.';
    await screen.findByText(read);
    const lines = document.querySelectorAll('.sr-cap > span');
    expect(Array.from(lines, (line) => line.textContent)).toEqual([read, shown]);
    await user.type(searchBox(), 'x');
    await screen.findByText('Sin resultados para “ec2x”');
    expect(screen.getByText(read)).toBeInTheDocument();
    expect(screen.queryByText(shown)).toBeNull();
  });

  it('keeps the list and says «Buscando…» only when an answer is slow', async () => {
    const user = userEvent.setup();
    let release: (value: SearchAnswer) => void = () => undefined;
    const call = vi
      .fn()
      .mockResolvedValueOnce(answer())
      .mockImplementation(
        () =>
          new Promise<SearchAnswer>((resolve) => {
            release = resolve;
          }),
      );
    renderPage(call);
    await user.type(searchBox(), 'ec2');
    await screen.findByText('Tú');
    expect(screen.queryByText('Buscando…', { selector: '.sr-busy' })).toBeNull();
    await user.type(searchBox(), 'x');
    // The previous list stays; past 400 ms the line shows next to the count.
    expect(await screen.findByText('Buscando…', { selector: '.sr-busy' })).toBeInTheDocument();
    expect(screen.getByText('Tú')).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true');
    release(answer({ results: [] }));
    await screen.findByText('Sin resultados para “ec2x”');
    expect(screen.queryByText('Buscando…', { selector: '.sr-busy' })).toBeNull();
  });

  it('offers «Reintentar» after a failure', async () => {
    const user = userEvent.setup();
    const call = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'search_unavailable', 'please try again'))
      .mockResolvedValue(answer());
    renderPage(call);
    await user.type(searchBox(), 'ec2');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No se pudo buscar en tus conversaciones.');
    await user.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Tú')).toBeInTheDocument();
  });
});
