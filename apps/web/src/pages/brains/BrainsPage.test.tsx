import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { BrainsPage } from './BrainsPage';
import type { Catalog, Model } from './model';

const XSS = '<img src=x onerror=alert(1)>';
const SONNET = 'us.anthropic.claude-sonnet-4-6';
const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

function model(overrides: Partial<Model> & Pick<Model, 'id' | 'name'>): Model {
  return {
    provider: 'Anthropic',
    status: 'available',
    is_default: false,
    supports_tools: true,
    supports_vision: true,
    context_tokens: null,
    input_usd: null,
    output_usd: null,
    cache_read_usd: null,
    cache_write_usd: null,
    list_input_usd: null,
    list_output_usd: null,
    confirmed_by: null,
    confirmed_at: null,
    disabled_by: null,
    disabled_at: null,
    disabled_reason: null,
    agents: [],
    ...overrides,
  };
}

const sonnet = model({
  id: SONNET,
  name: 'Claude Sonnet 4.6',
  status: 'enabled',
  is_default: true,
  input_usd: '3',
  output_usd: '15',
  list_input_usd: '3',
  list_output_usd: '15',
  agents: [{ id: 'finops', name: 'FinOps', category: '' }],
});
const haiku = model({
  id: HAIKU,
  name: 'Claude Haiku 4.5',
  input_usd: '1',
  output_usd: '5',
  list_input_usd: '1',
  list_output_usd: '5',
});
const opus = model({
  id: 'us.anthropic.claude-opus-4-7',
  name: 'Claude Opus 4.7',
  status: 'enabled',
  input_usd: '4.5',
  output_usd: '22.5',
  confirmed_by: 'otra.admin@example.com',
  agents: [
    { id: 'k3fq7zr2m5xw6n4a', name: XSS, category: 'Legal' },
    { id: 'b3fq7zr2m5xw6n4a', name: 'Analista', category: 'FinOps' },
  ],
});
const nova = model({
  id: 'us.amazon.nova-pro-v1:0',
  name: 'Nova Pro',
  provider: 'Amazon',
  supports_tools: false,
  supports_vision: false,
});
const llama = model({
  id: 'us.meta.llama4',
  name: 'Llama 4',
  provider: 'Meta',
  status: 'noaccess',
});
const retired = model({
  id: 'us.anthropic.claude-3-haiku',
  name: 'Claude 3 Haiku',
  status: 'disabled',
  input_usd: '0.25',
  output_usd: '1.25',
  disabled_by: 'ana@example.com',
  disabled_reason: XSS,
});

function catalog(items: Model[], overrides: Partial<Catalog> = {}): Catalog {
  return {
    version: 7,
    region: 'us-east-1',
    refreshed_at: '2026-10-01T12:00:00+00:00',
    items,
    ...overrides,
  };
}

const ALL = [sonnet, haiku, opus, nova, llama, retired];

function renderPage(call: ReturnType<typeof vi.fn>, isAdmin = true) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders session={sessionValue({ api, me: { ...baseMe, is_admin: isAdmin } })}>
      <BrainsPage />
    </TestProviders>,
  );
}

/** An API whose catalog is `initial` and whose writes answer with `next`. */
function apiWith(initial: Catalog, next: Partial<Record<string, Catalog | Error>> = {}) {
  return vi.fn((operation: string) => {
    const answer = operation === 'getAdminModels' ? initial : next[operation];
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${operation}`));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
}

async function openModel(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: new RegExp(name) }));
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

describe('BrainsPage', () => {
  it('lists the catalog in the design order, with what the API sent as text', async () => {
    renderPage(apiWith(catalog(ALL, { refreshed_at: new Date().toISOString() })));
    expect(await screen.findByRole('heading', { level: 1, name: 'Brains' })).toBeVisible();
    const rows = screen
      .getAllByRole('button')
      .filter((button) => button.classList.contains('mv-tr'));
    expect(rows.map((row) => row.querySelector('.mk-name')?.textContent)).toEqual([
      'Claude Opus 4.7',
      'Claude Sonnet 4.6',
      'Nova Pro',
      'Claude Haiku 4.5',
      'Claude 3 Haiku',
      'Llama 4',
    ]);
    const first = rows[1];
    if (!first) throw new Error('no rows');
    expect(first).toHaveTextContent('Por defecto');
    expect(first).toHaveTextContent('Habilitado');
    expect(first).toHaveTextContent('USD 3,00 / USD 15,00');
    expect(first).toHaveTextContent(SONNET);
    // No usage metrics yet: the design's own "Sin datos", never sample numbers.
    expect(first).toHaveTextContent('Sin datos');
    expect(rows[2]).toHaveTextContent('Sin precio');
    expect(rows[5]).toHaveClass('is-dim');
    expect(screen.getByText(/Conectado a Amazon Bedrock/)).toHaveTextContent('us-east-1');
    expect(screen.getByText(/Última consulta del catálogo/)).toBeVisible();
    // Providers outside AWS are only announced.
    expect(screen.getByText('Google Gemini')).toBeVisible();
    expect(screen.getAllByText('Los datos salen de AWS')).toHaveLength(2);
  });

  it('shows the context size the release knows, and "Sin datos" otherwise', async () => {
    const user = userEvent.setup();
    renderPage(
      apiWith(
        catalog([
          { ...sonnet, context_tokens: 200_000 },
          { ...haiku, context_tokens: null },
        ]),
      ),
    );
    await screen.findByText('Claude Sonnet 4.6');
    const rows = screen
      .getAllByRole('button')
      .filter((button) => button.classList.contains('mv-tr'));
    expect(within(rows[0] as HTMLElement).getByTitle('Tamaño de contexto')).toHaveTextContent(
      '200k',
    );
    expect(within(rows[1] as HTMLElement).queryByTitle('Tamaño de contexto')).toBeNull();

    await user.click(rows[0] as HTMLElement);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Contexto').parentElement).toHaveTextContent(
      /200[.\s\u00a0]?000 tokens/,
    );
  });

  it('shows identifiers instead of names while Bedrock was never asked', async () => {
    const user = userEvent.setup();
    renderPage(apiWith(catalog([sonnet], { refreshed_at: null })));
    expect(
      await screen.findByText('Todavía no se ha consultado el catálogo de Bedrock.'),
    ).toBeVisible();
    const row = screen.getByRole('button', { name: new RegExp(SONNET) });
    expect(row.querySelector('.mk-name')).toHaveTextContent(SONNET);
    expect(row.querySelector('.mk-name')).toHaveClass('mono');
    expect(screen.queryByText('Claude Sonnet 4.6')).toBeNull();
    await user.click(row);
    expect(
      within(screen.getByRole('dialog', { name: SONNET })).getByRole('heading', { level: 2 }),
    ).toHaveClass('mono');
  });

  it('says what the installation does not know about a model', async () => {
    renderPage(
      apiWith(catalog([nova, { ...haiku, supports_tools: false, context_tokens: 200_000 }])),
    );
    const { user, panel } = await openModel('Nova Pro');
    expect(
      within(panel).getByText(
        'La instalación no conoce este modelo: entra sin uso de tools y solo sirve para agentes sin MCP.',
      ),
    ).toBeVisible();
    expect(within(panel).getByText('Contexto').parentElement).toHaveTextContent('Sin datos');
    expect(within(panel).getByText('Sin precio todavía. Se indica al habilitarlo.')).toBeVisible();
    expect(within(panel).queryByText('Entrada')).toBeNull();
    expect(
      within(panel).getByText('Sin datos. Aparecerán cuando haya llamadas reales.'),
    ).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Cerrar' }));
    const known = (await openModel('Claude Haiku 4.5')).panel;
    expect(
      within(known).getByText('Sin uso de tools: solo sirve para agentes que no consultan MCP.'),
    ).toBeVisible();
  });

  it('shows the cache prices the API keeps in proportion to the input price', async () => {
    renderPage(
      apiWith(catalog([{ ...sonnet, cache_read_usd: '0.3', cache_write_usd: '3.75' }, haiku])),
    );
    const { user, panel } = await openModel('Claude Sonnet 4.6');
    expect(within(panel).getByText('Lectura de caché').parentElement).toHaveTextContent('USD 0,30');
    expect(within(panel).getByText('Escritura de caché').parentElement).toHaveTextContent(
      'USD 3,75',
    );
    await user.click(within(panel).getByRole('button', { name: 'Editar precios' }));
    const note =
      'Los precios de lectura y escritura de caché se ajustan en la misma proporción que el de entrada.';
    expect(within(panel).queryByText(note)).toBeNull();
    const input = within(panel).getByRole('textbox', { name: 'Entrada · por millón' });
    await user.clear(input);
    await user.type(input, '2,7');
    expect(within(panel).getByText(note)).toBeVisible();
  });

  it('filters by status, provider, capability and text, and clears', async () => {
    const user = userEvent.setup();
    renderPage(apiWith(catalog(ALL)));
    const status = within(await screen.findByRole('group', { name: 'Estado' }));
    const names = () =>
      [...document.querySelectorAll('.mv-tr .mk-name')].map((node) => node.textContent);
    expect(status.getByRole('button', { name: /Todos/ })).toHaveTextContent('6');
    expect(status.getByRole('button', { name: /Habilitados/ })).toHaveTextContent('2');
    expect(status.getByRole('button', { name: /Sin acceso/ })).toHaveTextContent('1');
    expect(screen.queryByRole('button', { name: 'Limpiar' })).toBeNull();

    await user.click(status.getByRole('button', { name: /Disponibles/ }));
    expect(names()).toEqual(['Nova Pro', 'Claude Haiku 4.5']);
    expect(status.getByRole('button', { name: /Disponibles/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('checkbox', { name: 'Uso de tools' }));
    expect(names()).toEqual(['Claude Haiku 4.5']);
    // The counters follow the other filters.
    expect(status.getByRole('button', { name: /Todos/ })).toHaveTextContent('5');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Proveedor' }), 'Meta');
    expect(screen.getByText('Ningún modelo coincide')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Limpiar' }));
    expect(names()).toHaveLength(6);
    await user.type(screen.getByRole('textbox', { name: 'Buscar modelos' }), 'nova-pro');
    expect(names()).toEqual(['Nova Pro']);
  });

  it('enables a model once the prices are confirmed', async () => {
    const enabled = { ...haiku, status: 'enabled' as const, input_usd: '0.8', output_usd: '4' };
    const call = apiWith(catalog([sonnet, haiku]), {
      putAdminModel: catalog([sonnet, enabled], { version: 8 }),
    });
    renderPage(call);
    const { user, panel } = await openModel('Claude Haiku 4.5');
    expect(
      within(panel).getByText('Precio de lista de Bedrock. Se confirma al habilitarlo.'),
    ).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Habilitar en Mango' }));

    const input = within(panel).getByRole('textbox', { name: 'Entrada · por millón' });
    const output = within(panel).getByRole('textbox', { name: 'Salida · por millón' });
    expect(input).toHaveValue('1');
    expect(output).toHaveValue('5');
    const submit = within(panel).getByRole('button', { name: 'Habilitar modelo' });
    expect(submit).toBeDisabled();
    expect(within(panel).getByText(/costaría ≈ USD 0,007\./)).toBeVisible();

    await user.clear(input);
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Los precios deben ser mayores que 0',
    );
    await user.type(input, '0,8');
    await user.clear(output);
    await user.type(output, '4');
    expect(within(panel).getByText(/Difiere del precio de lista de Bedrock/)).toHaveTextContent(
      'USD 1,00 / USD 5,00',
    );
    expect(submit).toBeDisabled();
    await user.click(
      within(panel).getByRole('checkbox', {
        name: 'Confirmo que estos precios son correctos para esta cuenta.',
      }),
    );
    await user.click(submit);

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('putAdminModel', {
        path: { model_id: HAIKU },
        body: { version: 7, enabled: true, input_usd: '0.8', output_usd: '4' },
      });
    });
    expect(
      await screen.findByText('Claude Haiku 4.5 habilitado · ya aparece en el Agent Builder'),
    ).toBeVisible();
    // The panel shows the new state: the actions of an enabled model.
    expect(within(panel).getByRole('button', { name: 'Editar precios' })).toBeVisible();
    expect(within(panel).getByText('USD 0,80')).toBeVisible();
  });

  it('never sends a price it could not read', async () => {
    const call = apiWith(catalog([haiku]));
    renderPage(call);
    const { user, panel } = await openModel('Claude Haiku 4.5');
    await user.click(within(panel).getByRole('button', { name: 'Habilitar en Mango' }));
    const input = within(panel).getByRole('textbox', { name: 'Entrada · por millón' });
    await user.clear(input);
    await user.type(input, '0.8');
    await user.click(within(panel).getByRole('checkbox'));
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Usa coma para los decimales (0,8). El punto solo separa miles.',
    );
    expect(within(panel).getByRole('button', { name: 'Habilitar modelo' })).toBeDisabled();
    await user.type(input, '{Enter}');
    // Second range error: over USD 100.000 (the API's limit) or more than four decimals.
    for (const typed of ['100.001', '0,12345']) {
      await user.clear(input);
      await user.type(input, typed);
      expect(within(panel).getByRole('alert')).toHaveTextContent(
        'Cada precio debe estar entre 0 y USD 100.000 por millón, con hasta 4 decimales.',
      );
    }
    await user.clear(input);
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Los precios deben ser mayores que 0',
    );
    await user.type(input, '{Enter}');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('shows the agents affected before disabling, and sends the reason', async () => {
    const disabled = { ...opus, status: 'disabled' as const, disabled_by: 'ana@example.com' };
    const call = apiWith(catalog([sonnet, opus]), {
      putAdminModel: catalog([sonnet, disabled], { version: 8 }),
    });
    renderPage(call);
    const { user, panel } = await openModel('Claude Opus 4.7');
    expect(within(panel).getByText('Confirmado por otra.admin@example.com.')).toBeVisible();
    expect(within(panel).getByRole('heading', { name: 'agentes que lo usan · 2' })).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Deshabilitar' }));

    expect(within(panel).getByText('2 agentes publicados lo usan')).toBeVisible();
    expect(
      within(panel).getByText(
        'Lo siguen usando hasta que se publique otra versión. No se podrá elegir en versiones nuevas.',
      ),
    ).toBeVisible();
    // Names written by creators are text, never markup.
    expect(within(panel).getAllByText(XSS, { exact: false }).length).toBeGreaterThan(0);
    expect(panel.querySelector('img')).toBeNull();

    await user.type(within(panel).getByRole('textbox', { name: /Motivo/ }), '  Contrato vencido ');
    await user.click(within(panel).getByRole('button', { name: 'Deshabilitar' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('putAdminModel', {
        path: { model_id: opus.id },
        body: { version: 7, enabled: false, reason: 'Contrato vencido' },
      });
    });
    expect(await screen.findByText('Claude Opus 4.7 deshabilitado')).toBeVisible();
    expect(within(panel).getByRole('button', { name: 'Volver a habilitar' })).toBeVisible();
  });

  it('does not offer to disable the default model', async () => {
    renderPage(apiWith(catalog([sonnet])));
    const { panel } = await openModel('Claude Sonnet 4.6');
    const disable = within(panel).getByRole('button', { name: 'Deshabilitar' });
    expect(disable).toBeDisabled();
    expect(disable).toHaveAttribute('title', 'Es el modelo por defecto');
    expect(within(panel).getByRole('button', { name: 'Editar precios' })).toBeEnabled();
  });

  it('explains "Sin acceso" and offers nothing to do from Mango', async () => {
    renderPage(apiWith(catalog([llama])));
    const { panel } = await openModel('Llama 4');
    expect(
      within(panel).getByText(
        /Bedrock no listó este modelo en la última consulta\. Mango no sabe si la cuenta tiene el acceso concedido: revísalo en la consola de Bedrock\./,
      ),
    ).toBeVisible();
    expect(
      within(panel).getByText(
        'Se resuelve en la consola de Bedrock de tu cuenta de AWS, no desde Mango.',
      ),
    ).toBeVisible();
    expect(within(panel).queryByRole('button', { name: /Habilitar/ })).toBeNull();
  });

  it('renders the reason of a disabled model as text', async () => {
    renderPage(apiWith(catalog([retired])));
    const { panel } = await openModel('Claude 3 Haiku');
    expect(within(panel).getByText(`Deshabilitado por ana@example.com: “${XSS}”.`)).toBeVisible();
    expect(panel.querySelector('img')).toBeNull();
  });

  it('reloads the catalog when another administrator changed it', async () => {
    const fresh = catalog([sonnet, { ...haiku, name: 'Claude Haiku 4.5' }], { version: 9 });
    const call = vi
      .fn()
      .mockResolvedValueOnce(catalog([sonnet, haiku]))
      .mockRejectedValueOnce(new ApiError(409, 'version_conflict', 'stale'))
      .mockResolvedValueOnce(fresh);
    renderPage(call);
    const { user, panel } = await openModel('Claude Haiku 4.5');
    await user.click(within(panel).getByRole('button', { name: 'Habilitar en Mango' }));
    await user.click(within(panel).getByRole('checkbox'));
    await user.click(within(panel).getByRole('button', { name: 'Habilitar modelo' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Otro administrador cambió este modelo mientras lo editabas. Cierra el panel y vuelve a abrirlo.',
    );
    expect(call).toHaveBeenNthCalledWith(3, 'getAdminModels');
    // The form stays open: the next attempt uses the reloaded version.
    call.mockResolvedValueOnce(catalog([sonnet, { ...haiku, status: 'enabled' }], { version: 10 }));
    await user.click(within(panel).getByRole('button', { name: 'Habilitar modelo' }));
    await waitFor(() => {
      expect(call).toHaveBeenLastCalledWith(
        'putAdminModel',
        expect.objectContaining({ body: expect.objectContaining({ version: 9 }) as unknown }),
      );
    });
  });

  it('shows the server error and keeps the model as it was', async () => {
    const call = apiWith(catalog([haiku]), {
      putAdminModel: new ApiError(409, 'model_no_access', 'no access'),
    });
    renderPage(call);
    const { user, panel } = await openModel('Claude Haiku 4.5');
    await user.click(within(panel).getByRole('button', { name: 'Habilitar en Mango' }));
    await user.click(within(panel).getByRole('checkbox'));
    await user.click(within(panel).getByRole('button', { name: 'Habilitar modelo' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'La cuenta no tiene acceso a este modelo en Bedrock. No se habilitó.',
    );
    // The raw server message is never shown.
    expect(panel).not.toHaveTextContent('no access');
  });

  it.each([
    [new ApiError(403, 'forbidden', 'not allowed'), 'No tienes acceso para cambiar modelos.'],
    [
      new ApiError(503, 'audit_unavailable', 'retry'),
      'No se pudo registrar el cambio en Auditoría, así que no se aplicó. Inténtalo de nuevo.',
    ],
  ])('says in the footer why the server refused (%#)', async (failure, text) => {
    renderPage(apiWith(catalog([opus]), { putAdminModel: failure }));
    const { user, panel } = await openModel('Claude Opus 4.7');
    await user.click(within(panel).getByRole('button', { name: 'Deshabilitar' }));
    expect(
      within(panel).getByText(
        'Lo siguen usando hasta que se publique otra versión. No se podrá elegir en versiones nuevas.',
      ),
    ).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Deshabilitar' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(alert.closest('.mc-foot')).not.toBeNull();
  });

  it('refreshes the catalog from Bedrock and says how many models are new', async () => {
    const user = userEvent.setup();
    const call = apiWith(catalog([sonnet]), {
      refreshAdminModels: catalog([sonnet, nova], { refreshed_at: new Date().toISOString() }),
    });
    renderPage(call);
    await user.click(await screen.findByRole('button', { name: 'Actualizar catálogo' }));
    expect(call).toHaveBeenCalledWith('refreshAdminModels', { body: {} });
    expect(
      await screen.findByText('Catálogo de Bedrock actualizado · 1 modelo nuevo'),
    ).toBeVisible();
    expect(screen.getByText('Nova Pro')).toBeVisible();

    call.mockImplementation(() => Promise.resolve(catalog([sonnet, nova])));
    await user.click(screen.getByRole('button', { name: 'Actualizar catálogo' }));
    expect(
      await screen.findByText('Catálogo de Bedrock actualizado · sin modelos nuevos'),
    ).toBeVisible();
  });

  it('keeps the catalog when Bedrock cannot be reached', async () => {
    const user = userEvent.setup();
    const call = apiWith(catalog([sonnet]), {
      refreshAdminModels: new ApiError(502, 'bedrock_unavailable', 'down'),
    });
    renderPage(call);
    await user.click(await screen.findByRole('button', { name: 'Actualizar catálogo' }));
    expect(await screen.findByText(/No se pudo consultar Amazon Bedrock/)).toBeVisible();
    expect(screen.getByText('Claude Sonnet 4.6')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Actualizar catálogo' })).toBeEnabled();
  });

  it('is only for administrators: it does not even ask the API otherwise', () => {
    const call = vi.fn();
    renderPage(call, false);
    expect(screen.getByText('No tienes acceso a esta sección')).toBeVisible();
    expect(screen.getByText('Brains es solo para administradores de Mango.')).toBeVisible();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows the denied state when the API refuses', async () => {
    const call = vi.fn().mockRejectedValueOnce(new ApiError(403, 'forbidden', 'not allowed'));
    renderPage(call);
    expect(await screen.findByText('No tienes acceso a esta sección')).toBeVisible();
  });

  it('lets the administrator retry a failed load', async () => {
    const user = userEvent.setup();
    const call = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'models_unavailable', 'try again'))
      .mockResolvedValueOnce(catalog([sonnet]));
    renderPage(call);
    expect(await screen.findByText('No se pudo cargar el catálogo de modelos')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Claude Sonnet 4.6')).toBeVisible();
  });
});
