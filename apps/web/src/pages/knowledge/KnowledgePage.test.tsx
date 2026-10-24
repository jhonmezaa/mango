import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { KnowledgePage } from './KnowledgePage';
import type { KnowledgeBase, KnowledgeList } from './model';
import { ADMIN_ID, KB_ID, OTHER_KB, XSS, bucketKb, kb, list, source } from './testFixtures';

type Answer = unknown;

function renderPage(call: ReturnType<typeof vi.fn>, me = baseMe) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders session={sessionValue({ api, me })}>
      <KnowledgePage />
    </TestProviders>,
  );
}

/** An API whose list is `initial`; other operations answer from `answers`. */
function apiWith(initial: KnowledgeList, answers: Partial<Record<string, Answer>> = {}) {
  return vi.fn((operation: string) => {
    let answer: Answer;
    if (operation === 'listKnowledgeBases') answer = answers.listKnowledgeBases ?? initial;
    else if (operation === 'listGroups')
      answer = answers.listGroups ?? {
        items: [{ id: 'finops-central' }, { id: 'hr' }, { id: 'mango-admin' }].map((g) => ({
          ...g,
          area: null,
          description: '',
          type: 'general',
        })),
      };
    else answer = answers[operation];
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${operation}`));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
}

function writes(call: ReturnType<typeof vi.fn>) {
  return call.mock.calls.filter(
    ([operation]) =>
      !['listKnowledgeBases', 'listGroups', 'listSources', 'listDocuments'].includes(
        operation as string,
      ),
  );
}

function rows() {
  return screen
    .getAllByRole('button')
    .filter((button) => button.classList.contains('kb-tr') && !button.classList.contains('mc-th'));
}

async function open(name: string) {
  const user = userEvent.setup();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${escaped}`) }));
  return { user, panel: screen.getByRole('dialog', { name }) };
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

describe('KnowledgePage', () => {
  it('lists the knowledge bases with their status, size, groups and agents', async () => {
    const items: KnowledgeBase[] = [
      kb({
        agents: [{ agent_id: 'a', name: 'People Docs', groups_without_access: ['mango-admin'] }],
        groups: ['finops-central', 'hr', 'legal'],
      }),
      bucketKb({ status_reason: 'budget', documents: 0, bytes: 0 }),
    ];
    renderPage(apiWith(list(items)));
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge Bases' })).toBeVisible();
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    const [hr, runbooks] = rows();
    expect(hr).toHaveTextContent('Indexada');
    expect(hr).toHaveTextContent('12 docs · 48 MB');
    expect(hr).toHaveTextContent('+1');
    expect(hr).toHaveTextContent('Acceso parcial');
    expect(runbooks).toHaveTextContent('No empezó');
    expect(runbooks).toHaveTextContent('por presupuesto');
    expect(runbooks).toHaveTextContent('—');
    // KPIs: two bases, one in use, one needing attention; queries are "Próximamente".
    expect(screen.getByText('1 en uso por agentes')).toBeVisible();
    expect(screen.getByText('Errores, avisos o sin empezar')).toBeVisible();
    expect(screen.getByRole('button', { name: /Necesitan atención1/ })).toBeVisible();
  });

  it('filters by status, origin and text', async () => {
    renderPage(apiWith(list([kb(), bucketKb({ status_reason: 'full' })])));
    const user = userEvent.setup();
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: /^Necesitan atención/ }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent('Con avisos');
    expect(rows()[0]).toHaveTextContent('supera el tope');
    await user.click(screen.getByRole('button', { name: /^Todas/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Fuente' }), 'upload');
    expect(rows()).toHaveLength(1);
    await user.type(screen.getByRole('textbox', { name: 'Buscar' }), 'nada');
    expect(screen.getByText('Ninguna coincide.')).toBeVisible();
  });

  it('renders names, descriptions and locations as text', async () => {
    const call = apiWith(
      list([
        bucketKb({
          name: XSS,
          description: XSS,
          sources: [{ src_id: 'x', status: 'approved', location: XSS }],
        }),
      ]),
      { listSources: { items: [] } },
    );
    renderPage(call);
    await waitFor(() => {
      expect(rows()).toHaveLength(1);
    });
    expect(document.querySelector('img')).toBeNull();
    const { panel } = await open(XSS);
    expect(within(panel).getAllByText(XSS).length).toBeGreaterThan(0);
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows the denied page when the API refuses the list', async () => {
    renderPage(vi.fn(() => Promise.reject(new ApiError(403, 'forbidden', 'no'))));
    expect(await screen.findByText('No tienes acceso a esta sección')).toBeVisible();
  });

  it('hides «Nueva knowledge base» when the API says the account cannot create', async () => {
    renderPage(apiWith(list([kb()], false)));
    await waitFor(() => {
      expect(rows()).toHaveLength(1);
    });
    expect(screen.queryByRole('button', { name: 'Nueva knowledge base' })).toBeNull();
  });
});

describe('the panel of a knowledge base', () => {
  it('summarizes a bucket waiting for approval and who proposed it', async () => {
    const pending = {
      src_id: 'p',
      status: 'pending',
      location: 's3://empresa-runbooks/ops/',
    } as const;
    renderPage(
      apiWith(list([bucketKb({ status: 'pending', sources: [pending] })]), {
        listSources: {
          items: [
            source({
              status: 'pending',
              proposed_by: { user_id: ADMIN_ID, email: 'usuario3@example.com' },
              decided_by: null,
              decided_at: null,
            }),
          ],
        },
      }),
    );
    const { panel } = await open('AWS Runbooks');
    expect(await within(panel).findByText(/usuario3@example.com propuso leer/)).toBeVisible();
    expect(within(panel).getByText('Pendiente de aprobación.')).toBeVisible();
    expect(within(panel).getByRole('button', { name: /Sincronizar ahora/ })).toBeDisabled();
    expect(
      within(panel).getByText('Se sincroniza sola cuando se apruebe el bucket.'),
    ).toBeVisible();
  });

  it('says the exact truth when a bucket passed the limits (owner, 2026-10-22)', async () => {
    renderPage(
      apiWith(list([bucketKb({ status_reason: 'full' })]), { listSources: { items: [source()] } }),
    );
    const { panel } = await open('AWS Runbooks');
    expect(
      within(panel).getByText(
        /Se copió hasta el tope: el bucket tiene más de 1.000 documentos o 5 GB/,
      ),
    ).toBeVisible();
    expect(within(panel).queryByText(/No empezó/)).toBeNull();
  });

  it('shows the budget estimate and the partial access of agents', async () => {
    renderPage(
      apiWith(
        list([
          kb({
            status_reason: 'budget',
            budget_estimate_usd: '12.4',
            agents: [
              { agent_id: 'a', name: 'People Docs', groups_without_access: ['mango-admin'] },
            ],
          }),
        ]),
      ),
    );
    const { panel } = await open('Políticas de RH');
    expect(within(panel).getByText(/los embeddings costarían unos USD 12,40/)).toBeVisible();
    expect(within(panel).getByText('Acceso parcial.')).toBeVisible();
    expect(within(panel).getByText('mango-admin')).toBeVisible();
    expect(within(panel).getByText('Lo usan grupos sin acceso')).toBeVisible();
  });

  it('names whose budget stopped it, and says when the schedule did (D88 (53))', async () => {
    renderPage(
      apiWith(
        list([
          kb({
            status_reason: 'budget',
            budget_estimate_usd: '12.4',
            budget_by: { user_id: baseMe.user_id, email: null, scheduled: false },
          }),
          bucketKb({
            status_reason: 'budget',
            budget_estimate_usd: null,
            budget_by: { user_id: ADMIN_ID, email: 'admin@example.com', scheduled: true },
          }),
        ]),
        { listSources: { items: [source()] } },
      ),
    );
    const opened = await open('Políticas de RH');
    const { user } = opened;
    let { panel } = opened;
    expect(
      within(panel).getByText(
        /^No empezó por presupuesto: los embeddings costarían unos USD 12,40 y tu presupuesto no alcanza\./,
      ),
    ).toBeVisible();
    expect(within(panel).getByText(/«Sincronizar ahora» usa el de quien la pide/)).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Cerrar' }));
    ({ panel } = await open('AWS Runbooks'));
    expect(
      within(panel).getByText(
        /^La sincronización programada no empezó por presupuesto: el presupuesto de admin@example.com no alcanza para los embeddings\./,
      ),
    ).toBeVisible();
  });

  it('says it is preparing the access of a bucket just approved', async () => {
    renderPage(
      apiWith(list([bucketKb({ status: 'syncing', sync_running: true, sync_preparing: true })]), {
        listSources: { items: [source()] },
      }),
    );
    expect(await screen.findByText('preparando el acceso')).toBeVisible();
    const { panel } = await open('AWS Runbooks');
    expect(
      within(panel).getByText(/^Preparando el acceso al bucket aprobado: puede tardar hasta 2/),
    ).toBeVisible();
    expect(within(panel).queryByText(/^Sincronizando desde/)).toBeNull();
  });

  it('says an approved bucket could not be read, and what to do', async () => {
    renderPage(
      apiWith(list([bucketKb({ status: 'error', status_reason: 'error' })]), {
        listSources: { items: [source()] },
      }),
    );
    expect(await screen.findByText('no se pudo leer')).toBeVisible();
    const { panel } = await open('AWS Runbooks');
    expect(
      within(panel).getByText(/^No se pudo sincronizar: Mango no pudo leer el bucket\./),
    ).toBeVisible();
    expect(
      within(panel).getByText(/pide a quien administra AWS que revise el bucket/),
    ).toBeVisible();
  });

  it('tells a proposal not sent from one withdrawn', async () => {
    renderPage(
      apiWith(
        list([
          bucketKb({ status: 'pending', sources: [] }),
          kb({
            kb_id: '01JC0000000000000000000003',
            name: 'Customer Docs',
            origin: 'bucket',
            status: 'pending',
            sources: [{ src_id: 'w', status: 'withdrawn', location: 's3://sitio/docs/' }],
          }),
        ]),
        { listSources: { items: [] } },
      ),
    );
    const opened = await open('AWS Runbooks');
    const { user } = opened;
    let { panel } = opened;
    expect(
      within(panel).getByText(/La propuesta del bucket no llegó a enviarse: no se lee nada\./),
    ).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Cerrar' }));
    ({ panel } = await open('Customer Docs'));
    expect(within(panel).getByText(/Se retiró la propuesta: no se lee nada\./)).toBeVisible();
  });

  it('says documents failed without a number to whoever does not see them', async () => {
    renderPage(apiWith(list([kb({ status: 'warn', can_view_documents: false })])));
    const { panel } = await open('Políticas de RH');
    expect(
      within(panel).getByText('Algunos documentos no se pudieron indexar: los agentes no los ven.'),
    ).toBeVisible();
  });

  it('synchronizes now, and says when one is already running', async () => {
    const call = apiWith(list([bucketKb()]), {
      listSources: { items: [source()] },
      synchronizeKnowledgeBase: { sync: 'queued' },
    });
    renderPage(call);
    const { user, panel } = await open('AWS Runbooks');
    await user.click(within(panel).getByRole('button', { name: /Sincronizar ahora/ }));
    expect(
      await within(panel).findByText(
        'Ya hay una sincronización en curso de esta knowledge base. Espera a que termine.',
      ),
    ).toBeVisible();
    expect(writes(call)).toEqual([
      ['synchronizeKnowledgeBase', { path: { kb_id: OTHER_KB }, body: {} }],
    ]);
  });

  it('saves the groups and the frequency with the version read', async () => {
    const saved = bucketKb({
      groups: ['finops-central', 'hr'],
      sync_schedule: 'weekly',
      version: 4,
    });
    const call = apiWith(list([bucketKb()]), {
      listSources: { items: [source()] },
      updateExistingKnowledgeBase: saved,
    });
    renderPage(call);
    const { user, panel } = await open('AWS Runbooks');
    await user.click(within(panel).getByRole('tab', { name: 'Acceso y sync' }));
    await user.click(await within(panel).findByRole('button', { name: 'hr' }));
    await user.click(within(panel).getByRole('button', { name: 'Semanal' }));
    await user.click(within(panel).getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => {
      expect(writes(call)).toEqual([
        [
          'updateExistingKnowledgeBase',
          {
            path: { kb_id: OTHER_KB },
            body: {
              version: 3,
              name: 'AWS Runbooks',
              description: 'Procedimientos de operación',
              groups: ['finops-central', 'hr'],
              sync_schedule: 'weekly',
            },
          },
        ],
      ]);
    });
    expect(await screen.findByText('Cambios guardados')).toBeVisible();
  });

  it('warns when the person is in none of the groups chosen', async () => {
    renderPage(apiWith(list([kb()])));
    const { user, panel } = await open('Políticas de RH');
    await user.click(within(panel).getByRole('tab', { name: 'Acceso' }));
    await user.click(await within(panel).findByRole('button', { name: 'hr' }));
    await user.click(within(panel).getByRole('button', { name: 'finops-central' }));
    expect(within(panel).getByText(/No estás en ninguno de estos grupos/)).toBeVisible();
  });

  it('proposes a change of bucket and shows what the server refuses', async () => {
    const call = apiWith(list([bucketKb()]), {
      listSources: { items: [source()] },
      propose: new ApiError(422, 'bucket_not_in_account', 'no'),
    });
    renderPage(call);
    const { user, panel } = await open('AWS Runbooks');
    await user.click(within(panel).getByRole('tab', { name: 'Acceso y sync' }));
    expect(await within(panel).findByText(/admin@example.com/)).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Cambiar bucket o prefijo' }));
    const field = within(panel).getByRole('textbox', { name: 'Bucket y prefijo' });
    // The same bucket of now is the API's to refuse (`source_exists`): the browser only checks
    // the shape and credentials.
    await user.clear(field);
    await user.type(field, 'no-es-s3');
    await user.click(within(panel).getByRole('button', { name: 'Enviar a aprobación' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Usa el formato s3://bucket/prefijo/',
    );
    await user.clear(field);
    await user.type(field, 's3://otra/carpeta/');
    await user.click(within(panel).getByRole('button', { name: 'Enviar a aprobación' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Ese bucket no está en la cuenta de AWS de la instalación.',
    );
    expect(writes(call)).toEqual([
      ['propose', { path: { kb_id: OTHER_KB }, body: { location: 's3://otra/carpeta/' } }],
    ]);
  });

  it('lets the proposer withdraw a pending proposal', async () => {
    const pending = source({ status: 'pending', decided_by: null, decided_at: null });
    const call = apiWith(
      list([
        bucketKb({
          status: 'pending',
          sources: [{ src_id: 'p', status: 'pending', location: null }],
        }),
      ]),
      { listSources: { items: [pending] }, deleteSource: { ...pending, status: 'withdrawn' } },
    );
    renderPage(call);
    const { user, panel } = await open('AWS Runbooks');
    await user.click(within(panel).getByRole('tab', { name: 'Acceso y sync' }));
    await user.click(await within(panel).findByRole('button', { name: 'Retirar propuesta' }));
    await waitFor(() => {
      expect(writes(call)).toEqual([
        [
          'deleteSource',
          { path: { kb_id: OTHER_KB, src_id: pending.src_id }, body: { version: 2 } },
        ],
      ]);
    });
  });

  it('does not offer to delete a knowledge base agents use', async () => {
    renderPage(
      apiWith(
        list([kb({ agents: [{ agent_id: 'a', name: 'People Docs', groups_without_access: [] }] })]),
      ),
    );
    const { user, panel } = await open('Políticas de RH');
    await user.click(within(panel).getByRole('tab', { name: 'Acceso' }));
    expect(
      within(panel).getByText(/No se puede borrar: la usa People Docs, ya publicado/),
    ).toBeVisible();
    expect(within(panel).getByRole('button', { name: 'Borrar knowledge base' })).toBeDisabled();
  });

  it('deletes after confirming in the row', async () => {
    const call = apiWith(list([kb()]), { deleteExistingKnowledgeBase: kb({ status: 'deleting' }) });
    renderPage(call);
    const { user, panel } = await open('Políticas de RH');
    await user.click(within(panel).getByRole('tab', { name: 'Acceso' }));
    await user.click(within(panel).getByRole('button', { name: 'Borrar knowledge base' }));
    expect(within(panel).getByText('¿Borrar Políticas de RH? No se puede deshacer.')).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Borrar' }));
    await waitFor(() => {
      expect(writes(call)).toEqual([
        ['deleteExistingKnowledgeBase', { path: { kb_id: KB_ID }, body: { version: 3 } }],
      ]);
    });
    expect((await within(panel).findAllByText('Borrando'))[0]).toBeVisible();
  });

  it('is read only for someone who cannot edit it', async () => {
    renderPage(
      apiWith(list([bucketKb({ can_edit: false })]), { listSources: { items: [source()] } }),
    );
    const { user, panel } = await open('AWS Runbooks');
    expect(within(panel).queryByRole('button', { name: /Sincronizar ahora/ })).toBeNull();
    await user.click(within(panel).getByRole('tab', { name: 'Acceso y sync' }));
    expect(within(panel).queryByRole('button', { name: 'Guardar cambios' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Borrar knowledge base' })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Semanal' })).toBeDisabled();
  });
});

describe('creating a knowledge base', () => {
  it('creates one of files and opens it', async () => {
    const created = kb({ kb_id: OTHER_KB, name: 'Manuales', status: 'pending', documents: 0 });
    const call = apiWith(list([]), { createNewKnowledgeBase: created });
    renderPage(call);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nueva knowledge base' }));
    const dialog = screen.getByRole('dialog', { name: 'Nueva knowledge base' });
    await user.click(within(dialog).getByRole('button', { name: 'Crear y subir archivos' }));
    expect(within(dialog).getByText('Escribe un nombre · Elige al menos un grupo')).toBeVisible();
    await user.type(within(dialog).getByRole('textbox', { name: 'Nombre' }), 'Manuales');
    await user.click(within(dialog).getByRole('button', { name: 'finops-central' }));
    await user.click(within(dialog).getByRole('button', { name: 'Crear y subir archivos' }));
    await waitFor(() => {
      expect(writes(call)).toEqual([
        [
          'createNewKnowledgeBase',
          {
            body: {
              name: 'Manuales',
              description: '',
              origin: 'upload',
              groups: ['finops-central'],
            },
          },
        ],
      ]);
    });
    expect(await screen.findByRole('dialog', { name: 'Manuales' })).toBeVisible();
    expect(screen.getByText('Creada · sube sus archivos')).toBeVisible();
  });

  it('creates one of a bucket and proposes its bucket', async () => {
    const created = bucketKb({ status: 'pending', sources: [] });
    const call = apiWith(list([]), {
      createNewKnowledgeBase: created,
      propose: source({ status: 'pending' }),
      listSources: { items: [] },
    });
    renderPage(call);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nueva knowledge base' }));
    const dialog = screen.getByRole('dialog', { name: 'Nueva knowledge base' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Nombre' }), 'AWS Runbooks');
    await user.click(within(dialog).getByRole('radio', { name: /Un bucket que ya existe/ }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Bucket y prefijo' }), 'bucket');
    await user.click(within(dialog).getByRole('button', { name: 'Semanal' }));
    await user.click(within(dialog).getByRole('button', { name: 'hr' }));
    expect(within(dialog).getByText(/No estás en ninguno de estos grupos/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Crear y enviar a aprobación' }));
    expect(
      within(dialog).getAllByText(/Usa el formato s3:\/\/bucket\/prefijo\//).length,
    ).toBeGreaterThan(0);
    const field = within(dialog).getByRole('textbox', { name: 'Bucket y prefijo' });
    await user.clear(field);
    await user.type(field, 's3://empresa-runbooks/ops/');
    await user.click(within(dialog).getByRole('button', { name: 'Crear y enviar a aprobación' }));
    await waitFor(() => {
      expect(writes(call)).toEqual([
        [
          'createNewKnowledgeBase',
          {
            body: {
              name: 'AWS Runbooks',
              description: '',
              origin: 'bucket',
              groups: ['hr'],
              sync_schedule: 'weekly',
            },
          },
        ],
        [
          'propose',
          { path: { kb_id: OTHER_KB }, body: { location: 's3://empresa-runbooks/ops/' } },
        ],
      ]);
    });
    expect(await screen.findByText('Creada · el bucket espera aprobación')).toBeVisible();
  });

  it('opens on «Acceso y sync» when the bucket of a new one could not be sent', async () => {
    const created = bucketKb({ status: 'pending', sources: [] });
    const call = apiWith(list([]), {
      createNewKnowledgeBase: created,
      propose: new ApiError(503, 'source_check_unavailable', 'no'),
      // Created all the same: the list read again brings it.
      listKnowledgeBases: list([created]),
      listSources: { items: [] },
    });
    renderPage(call);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nueva knowledge base' }));
    const dialog = screen.getByRole('dialog', { name: 'Nueva knowledge base' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Nombre' }), 'AWS Runbooks');
    await user.click(within(dialog).getByRole('radio', { name: /Un bucket que ya existe/ }));
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Bucket y prefijo' }),
      's3://empresa-runbooks/ops/',
    );
    await user.click(within(dialog).getByRole('button', { name: 'hr' }));
    await user.click(within(dialog).getByRole('button', { name: 'Crear y enviar a aprobación' }));
    const panel = await screen.findByRole('dialog', { name: 'AWS Runbooks' });
    expect(within(panel).getByRole('tab', { name: 'Acceso y sync' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Se creó la knowledge base, pero no se pudo enviar el bucket.',
    );
    // The form is open with what was typed, and the bucket says it was not sent.
    expect(within(panel).getByRole('textbox', { name: 'Bucket y prefijo' })).toHaveValue(
      's3://empresa-runbooks/ops/',
    );
    expect(screen.queryByText('Creada · el bucket espera aprobación')).toBeNull();
  });

  it('refuses credentials before sending anything', async () => {
    const call = apiWith(list([]));
    renderPage(call);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nueva knowledge base' }));
    const dialog = screen.getByRole('dialog', { name: 'Nueva knowledge base' });
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Nombre' }),
      'AKIAIOSFODNN7EXAMPLE',
    );
    await user.click(within(dialog).getByRole('button', { name: 'finops-central' }));
    await user.click(within(dialog).getByRole('button', { name: 'Crear y subir archivos' }));
    expect(within(dialog).getByText('No pegues credenciales')).toBeVisible();
    expect(writes(call)).toEqual([]);
  });
});

describe('a link to one knowledge base', () => {
  it('opens its panel from /knowledge/<id> (Aprobaciones, Bandeja)', async () => {
    const api = { call: apiWith(list([kb(), bucketKb({ sources: [] })])) } as unknown as ApiClient;
    render(
      <TestProviders session={sessionValue({ api })} path={`/knowledge/${KB_ID}`}>
        <Routes>
          <Route path="knowledge/*" element={<KnowledgePage />} />
        </Routes>
      </TestProviders>,
    );
    expect(await screen.findByRole('dialog', { name: 'Políticas de RH' })).toBeVisible();
  });

  it('ignores anything that is not an id', async () => {
    const api = { call: apiWith(list([kb()])) } as unknown as ApiClient;
    render(
      <TestProviders session={sessionValue({ api })} path="/knowledge/..%2Fadmin">
        <Routes>
          <Route path="knowledge/*" element={<KnowledgePage />} />
        </Routes>
      </TestProviders>,
    );
    await waitFor(() => {
      expect(rows()).toHaveLength(1);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
