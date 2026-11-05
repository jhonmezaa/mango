import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { baseMe, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { CostsPage } from './CostsPage';
import { costsFixture } from './fixture';

const adminMe = { ...baseMe, is_admin: true, groups: ['mango-admin'] };

function renderPage(call: ReturnType<typeof vi.fn>, me = baseMe) {
  const api = { call } as unknown as ApiClient;
  render(
    <TestProviders session={sessionValue({ api, me })} path="/costs">
      <Routes>
        <Route path="costs" element={<CostsPage />} />
        <Route path="budgets" element={<p>budgets page</p>} />
        <Route path="observability" element={<p>observability page</p>} />
        <Route path="/" element={<p>chat page</p>} />
      </Routes>
    </TestProviders>,
  );
}

/** The FinOps row of the table (its name is also in «cambios frente al mes anterior»). */
async function agentRow(): Promise<HTMLElement> {
  const [row] = await screen.findAllByRole('button', { name: /^FinOps/ });
  if (!row) throw new Error('no FinOps row');
  return row;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CostsPage · design round 37', () => {
  it('shows central FinOps the month with real queries, without the admin buttons', async () => {
    const call = vi.fn(() => Promise.resolve(costsFixture()));
    renderPage(call);
    expect(await screen.findByRole('heading', { name: 'Costos', level: 1 })).toBeInTheDocument();
    expect(call).toHaveBeenCalledWith('getCosts', {}, expect.anything());
    expect(
      screen.getByText(
        'Gasto en Amazon Bedrock de noviembre de 2026, día 20 de 30, con los precios de lista de Brains. No incluye el guardrail ni los embeddings.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('200 consultas')).toBeInTheDocument();
    expect(screen.getByText('USD 0,05')).toBeInTheDocument();
    expect(screen.getByText('60% del total')).toBeInTheDocument();
    expect(screen.getByText('Cuenta desde el', { exact: false })).toHaveTextContent(
      /17 sept?\.? 2026/,
    );
    expect(screen.getByText('Sin agente')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Presupuestos' })).toBeNull();
    // D107: «Por equipo» and «Oportunidades de ahorro» are «Próximamente».
    expect(screen.getByRole('button', { name: /Por equipo/ })).toBeDisabled();
    expect(screen.getByText('oportunidades de ahorro')).toBeInTheDocument();
    // An agent's name is text, never markup or a formula.
    expect(screen.getAllByText('=HYPERLINK("x")').length).toBeGreaterThan(0);
  });

  it('per model, «Sin desglose» before the counters and «Sin modelo» for the titles', async () => {
    const user = userEvent.setup();
    renderPage(vi.fn(() => Promise.resolve(costsFixture())));
    await user.click(await screen.findByRole('button', { name: 'Por modelo' }));
    expect(screen.getByText('Sin desglose')).toBeInTheDocument();
    expect(screen.getByText('Sin modelo')).toBeInTheDocument();
    expect(screen.getByText(/^Antes del 12 nov/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Por origen' }));
    expect(screen.getByText('Conversaciones')).toBeInTheDocument();
    expect(screen.getByText('Schedules')).toBeInTheDocument();
    expect(screen.getByText('Sin origen')).toBeInTheDocument();
  });

  it('opens the agent with its budget; only admins get the links', async () => {
    const user = userEvent.setup();
    renderPage(vi.fn(() => Promise.resolve(costsFixture())));
    await user.click(await agentRow());
    const drawer = screen.getByRole('dialog', { name: 'FinOps' });
    expect(within(drawer).getByText('81%')).toBeInTheDocument();
    expect(
      within(drawer).getByText('Al ritmo actual superará su límite antes de fin de mes.'),
    ).toBeInTheDocument();
    expect(within(drawer).getByText('Por origen')).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Ver presupuestos' })).toBeNull();
  });

  it('gives administrators «Presupuestos», «Ver presupuestos» and «Ver trazas»', async () => {
    const user = userEvent.setup();
    renderPage(
      vi.fn(() => Promise.resolve(costsFixture())),
      adminMe,
    );
    expect(await screen.findByRole('button', { name: 'Presupuestos' })).toBeInTheDocument();
    await user.click(await agentRow());
    expect(
      screen.getByText('El límite de un agente todavía no se cambia desde Mango.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ver trazas' }));
    expect(await screen.findByText('observability page')).toBeInTheDocument();
  });

  it('shows the 403, the error with «Reintentar» and the empty month', async () => {
    const denied = vi.fn(() => Promise.reject(new ApiError(403, 'forbidden', 'no')));
    renderPage(denied);
    expect(await screen.findByText('No tienes acceso a Costos')).toBeInTheDocument();
  });

  it('retries after an error', async () => {
    const user = userEvent.setup();
    const call = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'costs_unavailable', 'x'))
      .mockResolvedValueOnce(costsFixture({ spent_usd: '0.00' }));
    renderPage(call);
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar Costos.');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Todavía no hay gasto este mes')).toBeInTheDocument();
  });

  it('exports the CSV', async () => {
    const user = userEvent.setup();
    const create = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    renderPage(vi.fn(() => Promise.resolve(costsFixture())));
    await user.click(await screen.findByRole('button', { name: 'Exportar CSV' }));
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText('Costos exportados')).toBeInTheDocument();
  });
});
