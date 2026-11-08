import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../../api/client';
import { ApiError } from '../../../api/errors';
import { sessionValue } from '../../../test/fixtures';
import { TestProviders } from '../../../test/TestProviders';
import type { Textdoc } from './canvasApi';
import { CanvasPanel } from './CanvasPanel';
import { parseExportFiles, parseTextdocCards } from './textdocCards';

const CONVERSATION = 'c'.repeat(32);
const DOC = '01' + 'D'.repeat(24);
const COMMENT = '01' + 'E'.repeat(24);

const TEXTS: Record<number, string> = {
  1: '## Análisis\n\nGasto **alto**.',
  2: '## Análisis\n\nGasto de USD 124.530. <img src=x onerror=alert(1)>',
};

function doc(overrides: Partial<Textdoc> = {}): Textdoc {
  return {
    textdoc_id: DOC,
    title: 'Análisis de costos',
    kind: 'document',
    latest: 2,
    versions: [
      {
        version: 1,
        by: 'agent',
        note: '',
        created_at: '2026-11-08T12:04:00Z',
        chars: 30,
        restored_from: null,
      },
      {
        version: 2,
        by: 'agent',
        note: 'Puso la cifra',
        created_at: '2026-11-08T12:11:00Z',
        chars: 40,
        restored_from: null,
      },
    ],
    comments: [{ comment_id: COMMENT, version: 2, quote: 'USD 124.530', text: '¿Contra qué mes?' }],
    exports: ['md', 'docx', 'pdf'],
    ...overrides,
  };
}

function fakeApi(current: Textdoc = doc()) {
  const call = vi.fn(
    (
      id: string,
      input: { path: Record<string, unknown>; body?: Record<string, unknown> },
    ): Promise<unknown> => {
      if (id === 'getTextdoc') return Promise.resolve(current);
      if (id === 'getTextdocVersion') {
        const version = Number(input.path.version);
        return Promise.resolve({ textdoc_id: DOC, version, content: TEXTS[version] ?? '' });
      }
      if (id === 'saveTextdocVersion') {
        return Promise.resolve({
          version: 3,
          by: 'person',
          note: 'Editado por ti',
          created_at: '2026-11-08T12:20:00Z',
          chars: 3,
          restored_from: input.body?.restored_from ?? null,
        });
      }
      if (id === 'exportTextdoc') {
        return Promise.resolve({
          message_id: 'm',
          file: {
            file_id: '01' + 'F'.repeat(24),
            name: 'Análisis_de_costos.docx',
            kind: 'docx',
            size_bytes: 9,
            image: false,
            role: 'file',
          },
        });
      }
      return Promise.reject(new Error(`unexpected ${id}`));
    },
  );
  return { call, resolveTextdocComment: vi.fn(() => Promise.resolve()) };
}

function show(
  api: ReturnType<typeof fakeApi>,
  props: Partial<Parameters<typeof CanvasPanel>[0]> = {},
) {
  const handlers = { onClose: vi.fn(), onAsk: vi.fn(), onExported: vi.fn(), notify: vi.fn() };
  render(
    <TestProviders session={sessionValue({ api: api as unknown as ApiClient })}>
      <CanvasPanel
        conversationId={CONVERSATION}
        card={{ textdoc_id: DOC, title: 'Análisis de costos', kind: 'document', version: 2 }}
        agentName="FinOps"
        {...handlers}
        {...props}
      />
    </TestProviders>,
  );
  return handlers;
}

describe('CanvasPanel (design round 41, D124)', () => {
  it('shows the latest version as Markdown without raw HTML, with the agent comments marked', async () => {
    show(fakeApi());
    expect(await screen.findByText('Canvas · Documento · v2 de 2 · de FinOps')).toBeInTheDocument();
    const panel = screen.getByRole('complementary', { name: 'Canvas: Análisis de costos' });
    await screen.findByRole('heading', { name: 'Análisis' });
    // Raw HTML of the model never becomes an element.
    expect(panel.querySelector('img')).toBeNull();
    const mark = panel.querySelector('mark.cv-mark');
    expect(mark?.textContent).toBe('USD 124.530');
    expect(within(panel).getByText('1 comentario de FinOps')).toBeInTheDocument();
    expect(within(panel).getByText('¿Contra qué mes?')).toBeInTheDocument();
  });

  it('shows the changes against the previous version', async () => {
    show(fakeApi());
    await screen.findByRole('heading', { name: 'Análisis' });
    await userEvent.click(screen.getByRole('button', { name: /Mostrar cambios/ }));
    expect(await screen.findByText('Cambios de v1 a v2 · Puso la cifra')).toBeInTheDocument();
    const added = document.querySelector('.cv-diff .add');
    expect(added?.textContent).toContain('Gasto de USD 124.530.');
    expect(document.querySelector('.cv-diff .rem')?.textContent).toContain('Gasto **alto**.');
  });

  it('saves an edit as a new version on top of the one it showed', async () => {
    const api = fakeApi();
    const { notify } = show(api);
    await screen.findByRole('heading', { name: 'Análisis' });
    await userEvent.click(screen.getByRole('button', { name: /Editar/ }));
    const box = screen.getByRole('textbox', { name: 'Editar el contenido' });
    await userEvent.clear(box);
    await userEvent.type(box, 'uno');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar versión' }));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Guardado como v3.', 'success');
    });
    expect(api.call).toHaveBeenCalledWith('saveTextdocVersion', {
      path: { conversation_id: CONVERSATION, textdoc_id: DOC },
      body: { content: 'uno', base: 2 },
    });
  });

  it('says so when someone wrote a newer version first', async () => {
    const api = fakeApi();
    const original = api.call.getMockImplementation();
    if (!original) throw new Error('no fake');
    api.call.mockImplementation((id, input) =>
      id === 'saveTextdocVersion'
        ? Promise.reject(new ApiError(409, 'textdoc_conflict', 'x'))
        : original(id, input),
    );
    const { notify } = show(api);
    await screen.findByRole('heading', { name: 'Análisis' });
    await userEvent.click(screen.getByRole('button', { name: /Editar/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Editar el contenido' }), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar versión' }));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        'El documento tiene una versión más nueva. Ábrelo de nuevo para ver la actual.',
        'error',
      );
    });
  });

  it('restores an earlier version as a new one from the history', async () => {
    const api = fakeApi();
    show(api);
    await screen.findByRole('heading', { name: 'Análisis' });
    await userEvent.click(screen.getByRole('button', { name: 'Historial de versiones' }));
    const versions = screen.getByLabelText('Versiones');
    expect(within(versions).getByText('Primer borrador')).toBeInTheDocument();
    expect(within(versions).getByText('Actual')).toBeInTheDocument();
    await userEvent.click(within(versions).getByText('v1'));
    expect(await screen.findByText(/Estás viendo v1/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Restaurar esta versión' }));
    await waitFor(() => {
      expect(api.call).toHaveBeenCalledWith('saveTextdocVersion', {
        path: { conversation_id: CONVERSATION, textdoc_id: DOC },
        body: { content: TEXTS[1], base: 2, restored_from: 1 },
      });
    });
  });

  it('resolves a comment and answers one in the chat', async () => {
    const api = fakeApi();
    const { onAsk } = show(api);
    await screen.findByText('¿Contra qué mes?');
    await userEvent.click(screen.getByRole('button', { name: /Responder en el chat/ }));
    expect(onAsk).toHaveBeenCalledWith('Sobre «USD 124.530» en el Canvas: ');
    await userEvent.click(screen.getByRole('button', { name: /Resolver/ }));
    expect(screen.queryByText('¿Contra qué mes?')).toBeNull();
    expect(api.resolveTextdocComment).toHaveBeenCalledWith(CONVERSATION, DOC, COMMENT);
  });

  it('exports Word as a file of the chat and the Markdown straight away', async () => {
    const api = fakeApi();
    const createObjectURL = vi.fn(() => 'blob:canvas');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL: revoke });
    const { onExported, notify } = show(api);
    await screen.findByRole('heading', { name: 'Análisis' });
    await userEvent.click(screen.getByRole('button', { name: /Exportar/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Word/ }));
    expect(notify).toHaveBeenCalledWith('Generando DOCX. Aparecerá en la conversación.', 'info');
    await waitFor(() => {
      expect(onExported).toHaveBeenCalledWith(expect.objectContaining({ kind: 'docx' }));
    });
    await userEvent.click(screen.getByRole('button', { name: /Exportar/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /\.md/ }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const [blob] = createObjectURL.mock.calls[0] as unknown as [Blob];
    expect(blob.type).toBe('text/plain;charset=utf-8');
    expect(notify).toHaveBeenCalledWith('Descargando Análisis_de_costos.md', 'success');
  });

  it('opens code on its preview, with the tabs of the design', async () => {
    const code = doc({ kind: 'code/python', exports: ['py'], comments: [] });
    show(fakeApi(code), {
      card: { textdoc_id: DOC, title: 'Costo por servicio', kind: 'code/python', version: 2 },
    });
    expect(
      await screen.findByText('Canvas · Código · Python · v2 de 2 · de FinOps'),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Vista previa' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The test installation has no second origin: the preview says so, and nothing is framed.
    expect(
      await screen.findByText('La vista previa no está disponible en esta instalación.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Vista previa · contenido del agente, no de Mango'),
    ).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Código' }));
    expect(document.querySelector('.cv-code')?.textContent).toBe(TEXTS[2]);
  });

  it('says it could not open, and tries again', async () => {
    const api = fakeApi();
    api.call.mockImplementationOnce(() => Promise.reject(new ApiError(503, 'x', 'x')));
    show(api);
    expect(
      await screen.findByText('No se pudo abrir el Canvas. Inténtalo de nuevo.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('heading', { name: 'Análisis' });
  });
});

describe('the cards of an answer', () => {
  it('keeps the newest card of each document and leaves out what does not parse', () => {
    const card = { textdoc_id: DOC, title: 'T', kind: 'document', version: 1 };
    expect(
      parseTextdocCards([card, { ...card, version: 2 }, { ...card, textdoc_id: 'x' }, 'junk']),
    ).toEqual([{ ...card, version: 2 }]);
    expect(parseExportFiles([{ file_id: 'bad' }])).toEqual([]);
  });
});
