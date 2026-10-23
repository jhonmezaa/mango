import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { KnowledgePage } from './KnowledgePage';
import type { Document, KnowledgeList } from './model';
import { KB_ID, XSS, bucketKb, kb, list, source } from './testFixtures';

const postFile = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('./upload', () => ({ postFile }));

const READS = ['listKnowledgeBases', 'listGroups', 'listSources', 'listDocuments'];

function doc(overrides: Partial<Document> = {}): Document {
  return {
    doc_id: '01JE0000000000000000000001',
    name: 'Vacaciones-2026.pdf',
    size: 2_400_000,
    content_type: 'application/pdf',
    status: 'indexed',
    reason: null,
    created_at: '2026-10-21T10:00:00Z',
    ...overrides,
  };
}

function apiWith(initial: KnowledgeList, answers: Partial<Record<string, unknown>> = {}) {
  return vi.fn((operation: string) => {
    let answer: unknown;
    if (operation === 'listKnowledgeBases') answer = answers.listKnowledgeBases ?? initial;
    else if (operation === 'listGroups')
      answer = { items: [{ id: 'finops-central', area: null, description: '', type: 'general' }] };
    else answer = answers[operation];
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${operation}`));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
}

function writes(call: ReturnType<typeof vi.fn>) {
  return call.mock.calls.filter(([operation]) => !READS.includes(operation as string));
}

function renderPage(call: ReturnType<typeof vi.fn>, me = baseMe) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders session={sessionValue({ api, me })}>
      <KnowledgePage />
    </TestProviders>,
  );
}

async function open(name: string, tab?: string) {
  // A dropped file has no `accept` filter: the screen must refuse what it does not take.
  const user = userEvent.setup({ applyAccept: false });
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${name}`) }));
  const panel = screen.getByRole('dialog', { name });
  if (tab) await user.click(within(panel).getByRole('tab', { name: new RegExp(`^${tab}`) }));
  return { user, panel };
}

function files(...items: [string, number][]): File[] {
  return items.map(([name, size]) => {
    const file = new File(['x'], name);
    Object.defineProperty(file, 'size', { value: size });
    return file;
  });
}

beforeEach(() => {
  postFile.mockReset();
  postFile.mockImplementation(() => Promise.resolve());
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

describe('Documentos', () => {
  it('groups the documents and says why one was not indexed', async () => {
    const documents = [
      doc(),
      doc({ doc_id: '01JE0000000000000000000002', name: XSS, status: 'failed', reason: 'no_text' }),
      doc({ doc_id: '01JE0000000000000000000003', name: 'Nuevo.md', status: 'indexing' }),
      doc({
        doc_id: '01JE0000000000000000000004',
        name: 'Raro.pdf',
        status: 'failed',
        reason: 'otro',
      }),
    ];
    renderPage(apiWith(list([kb({ status: 'warn' })]), { listDocuments: { items: documents } }));
    const { user, panel } = await open('Políticas de RH');
    // The summary counts them and leads to them.
    expect(
      await within(panel).findByText(
        /2 documentos no se pudieron indexar: los agentes no los ven./,
      ),
    ).toBeVisible();
    expect(within(panel).getByRole('tab', { name: 'Documentos · 2 con error' })).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Ver cuáles' }));
    expect(within(panel).getByText('No indexados · 2')).toBeVisible();
    expect(within(panel).getByText('OCR sin texto legible')).toBeVisible();
    expect(within(panel).getByText('No se pudo indexar')).toBeVisible();
    expect(within(panel).getByText(XSS)).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
    expect(within(panel).getByText('En curso · 1')).toBeVisible();
    expect(within(panel).getByText('Indexados · 1')).toBeVisible();
    expect(
      within(panel).getByText('Los originales no se descargan desde Mango en esta versión.'),
    ).toBeVisible();
  });

  it('removes a document after confirming in its row', async () => {
    const call = apiWith(list([kb()]), {
      listDocuments: { items: [doc()] },
      deleteKnowledgeBaseDocument: { document: doc({ status: 'deleting' }), sync: 'started' },
    });
    renderPage(call);
    const { user, panel } = await open('Políticas de RH', 'Documentos');
    await user.click(
      await within(panel).findByRole('button', { name: 'Quitar Vacaciones-2026.pdf' }),
    );
    expect(
      within(panel).getByText('Deja de aparecer en las respuestas de los agentes.'),
    ).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Quitar' }));
    await waitFor(() => {
      expect(writes(call)).toEqual([
        [
          'deleteKnowledgeBaseDocument',
          { path: { kb_id: KB_ID, doc_id: '01JE0000000000000000000001' }, body: {} },
        ],
      ]);
    });
    expect(await screen.findByText('Quitando Vacaciones-2026.pdf')).toBeVisible();
  });

  it('says where the documents of a bucket come from, without removing them here', async () => {
    renderPage(
      apiWith(list([bucketKb()]), {
        listDocuments: { items: [doc()] },
        listSources: { items: [source()] },
      }),
    );
    const { panel } = await open('AWS Runbooks', 'Documentos');
    expect(
      await within(panel).findByText(/Vienen de s3:\/\/empresa-runbooks\/ops\//),
    ).toBeVisible();
    expect(within(panel).queryByRole('button', { name: /^Quitar/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Subir archivos' })).toBeNull();
  });

  it('is locked for someone who does not see the documents', async () => {
    const call = apiWith(
      list([kb({ can_view_documents: false, can_search: false, can_edit: false })]),
    );
    renderPage(call);
    const { user, panel } = await open('Políticas de RH', 'Documentos');
    expect(within(panel).getByText('No ves los documentos de esta knowledge base')).toBeVisible();
    await user.click(within(panel).getByRole('tab', { name: 'Probar búsqueda' }));
    expect(within(panel).getByText('No puedes probar la búsqueda')).toBeVisible();
    // Nothing of its documents was asked for.
    expect(call.mock.calls.some(([operation]) => operation === 'listDocuments')).toBe(false);
  });
});

describe('Subir archivos', () => {
  it('refuses in the browser what the API would, uploads the rest and saves it', async () => {
    const call = apiWith(list([kb({ documents: 0, bytes: 0, status: 'pending' })]), {
      listDocuments: { items: [] },
      requestDocumentUploads: {
        upload_id: '01JF0000000000000000000001',
        expires_at: '2026-10-23T10:15:00Z',
        files: [
          {
            doc_id: '01JE0000000000000000000009',
            name: 'Gastos.pdf',
            url: 'https://b.s3.amazonaws.com/',
            fields: { key: 'k' },
          },
        ],
      },
      saveUploadedDocuments: {
        saved: [
          doc({ doc_id: '01JE0000000000000000000009', name: 'Gastos.pdf', status: 'indexing' }),
        ],
        rejected: [],
        sync: 'started',
      },
    });
    renderPage(call);
    const { user, panel } = await open('Políticas de RH');
    // The link of the summary and the button of the footer both open it.
    const [, footer] = within(panel).getAllByRole('button', { name: 'Subir archivos' });
    if (!footer) throw new Error('no footer button');
    await user.click(footer);
    expect(within(panel).getByText('Subir archivos', { selector: '.sc-res-h' })).toBeVisible();
    await user.upload(
      screen.getByTestId('kb-file-input'),
      files(
        ['Gastos.pdf', 2_400_000],
        ['Organigrama.png', 800_000],
        ['Manual.pdf', 60 * 1024 * 1024],
      ),
    );
    expect(await within(panel).findByText('Subido · 2 MB')).toBeVisible();
    expect(within(panel).getByText('Rechazado · Tipo no admitido')).toBeVisible();
    expect(within(panel).getByText('Rechazado · Supera 50 MB')).toBeVisible();
    expect(writes(call)[0]).toEqual([
      'requestDocumentUploads',
      {
        path: { kb_id: KB_ID },
        body: { files: [{ name: 'Gastos.pdf', size: 2_400_000, content_type: 'application/pdf' }] },
      },
    ]);
    expect(postFile).toHaveBeenCalledTimes(1);
    await user.click(within(panel).getByRole('button', { name: 'Guardar 1 archivo' }));
    await waitFor(() => {
      expect(writes(call)[1]).toEqual([
        'saveUploadedDocuments',
        {
          path: { kb_id: KB_ID },
          body: {
            upload_id: '01JF0000000000000000000001',
            doc_ids: ['01JE0000000000000000000009'],
          },
        },
      ]);
    });
    expect(await screen.findByText('1 archivo guardado · indexando')).toBeVisible();
    // Back on the documents.
    expect(within(panel).queryByText('Subir archivos', { selector: '.sc-res-h' })).toBeNull();
  });

  it('keeps a file the server refused, with its reason', async () => {
    const call = apiWith(list([kb()]), {
      listDocuments: { items: [] },
      requestDocumentUploads: {
        upload_id: '01JF0000000000000000000001',
        expires_at: '2026-10-23T10:15:00Z',
        files: [
          {
            doc_id: '01JE0000000000000000000009',
            name: 'falso.pdf',
            url: 'https://b.s3.amazonaws.com/',
            fields: {},
          },
        ],
      },
      saveUploadedDocuments: {
        saved: [],
        rejected: [{ doc_id: '01JE0000000000000000000009', reason: 'type_mismatch' }],
        sync: null,
      },
    });
    renderPage(call);
    const { user, panel } = await open('Políticas de RH');
    await user.click(within(panel).getByRole('button', { name: 'Subir archivos' }));
    await user.upload(screen.getByTestId('kb-file-input'), files(['falso.pdf', 1000]));
    await user.click(await within(panel).findByRole('button', { name: 'Guardar 1 archivo' }));
    expect(
      await within(panel).findByText('Rechazado · El contenido no es del tipo que dice'),
    ).toBeVisible();
  });

  it('asks before leaving with files uploaded and not saved', async () => {
    const call = apiWith(list([kb()]), {
      listDocuments: { items: [] },
      requestDocumentUploads: {
        upload_id: '01JF0000000000000000000001',
        expires_at: '2026-10-23T10:15:00Z',
        files: [
          {
            doc_id: '01JE0000000000000000000009',
            name: 'a.md',
            url: 'https://b.s3.amazonaws.com/',
            fields: {},
          },
        ],
      },
    });
    renderPage(call);
    const { user, panel } = await open('Políticas de RH');
    await user.click(within(panel).getByRole('button', { name: 'Subir archivos' }));
    await user.upload(screen.getByTestId('kb-file-input'), files(['a.md', 1000]));
    await within(panel).findByText(/Subido/);
    await user.click(within(panel).getByRole('tab', { name: 'Resumen' }));
    expect(
      within(panel).getByText(
        'Tienes 1 archivo subido sin guardar. Si sales, no se agrega a la knowledge base y se descarta mañana.',
      ),
    ).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Seguir aquí' }));
    expect(within(panel).getByRole('tab', { name: /^Documentos/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(within(panel).getByRole('button', { name: 'Cerrar' }));
    await user.click(within(panel).getByRole('button', { name: 'Salir sin guardar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Políticas de RH' })).toBeNull();
    });
  });

  it('a knowledge base of files opens on its upload when it is created', async () => {
    const created = kb({
      kb_id: '01JC0000000000000000000009',
      name: 'Manuales',
      documents: 0,
      bytes: 0,
      status: 'pending',
    });
    renderPage(
      apiWith(list([], true), {
        createNewKnowledgeBase: created,
        listDocuments: { items: [] },
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nueva knowledge base' }));
    const dialog = screen.getByRole('dialog', { name: 'Nueva knowledge base' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Nombre' }), 'Manuales');
    await user.click(within(dialog).getByRole('button', { name: 'finops-central' }));
    await user.click(within(dialog).getByRole('button', { name: 'Crear y subir archivos' }));
    const panel = await screen.findByRole('dialog', { name: 'Manuales' });
    expect(within(panel).getByText('Subir archivos', { selector: '.sc-res-h' })).toBeVisible();
  });
});

describe('Probar búsqueda', () => {
  it('shows the fragments as text, with document, page and score', async () => {
    const call = apiWith(list([kb()]), {
      listDocuments: { items: [doc()] },
      search: {
        fragments: [
          {
            doc_id: 'd',
            document: 'Vacaciones-2026.pdf',
            page: 3,
            score: 0.58,
            text: `Texto ${XSS}`,
          },
          { doc_id: 'e', document: null, page: null, score: null, text: 'Otro' },
        ],
      },
    });
    renderPage(call);
    const { user, panel } = await open('Políticas de RH', 'Probar búsqueda');
    await user.type(
      within(panel).getByRole('textbox', { name: 'Consulta de prueba' }),
      'vacaciones{Enter}',
    );
    expect(await within(panel).findByText(`Texto ${XSS}`)).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
    expect(within(panel).getByText('· p. 3')).toBeVisible();
    expect(within(panel).getByText('0,58')).toBeVisible();
    expect(within(panel).getByText('Documento')).toBeVisible();
    expect(writes(call)).toEqual([
      ['search', { path: { kb_id: KB_ID }, body: { query: 'vacaciones' } }],
    ]);
  });

  it('says when nothing came back, and when the search is busy', async () => {
    const call = apiWith(list([kb()]), {
      listDocuments: { items: [doc()] },
      search: { fragments: [] },
    });
    renderPage(call);
    const { user, panel } = await open('Políticas de RH', 'Probar búsqueda');
    const field = within(panel).getByRole('textbox', { name: 'Consulta de prueba' });
    await user.type(field, 'nada{Enter}');
    expect(await within(panel).findByText('Sin resultados.')).toBeVisible();
    call.mockImplementation((operation: string) =>
      operation === 'search'
        ? Promise.reject(new ApiError(503, 'search_busy', 'busy'))
        : Promise.resolve(operation === 'listDocuments' ? { items: [doc()] } : list([kb()])),
    );
    await user.click(within(panel).getByRole('button', { name: 'Buscar' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'La búsqueda está ocupada. Inténtalo en un momento.',
    );
  });

  it('tells an owner or administrator outside its groups why they cannot test it', async () => {
    renderPage(apiWith(list([kb({ can_search: false })]), { listDocuments: { items: [] } }), {
      ...baseMe,
      is_admin: true,
    });
    const { panel } = await open('Políticas de RH', 'Probar búsqueda');
    expect(within(panel).getByText('No estás en los grupos de esta knowledge base')).toBeVisible();
    expect(within(panel).getByText(/Haberla creado o ser administrador no basta./)).toBeVisible();
  });

  it('has nothing to search before something is indexed', async () => {
    renderPage(
      apiWith(list([kb({ documents: 0, status: 'pending' })]), { listDocuments: { items: [] } }),
    );
    const { panel } = await open('Políticas de RH', 'Probar búsqueda');
    expect(
      within(panel).getByText('Aún no hay nada indexado: sube archivos para probarla.'),
    ).toBeVisible();
  });
});
