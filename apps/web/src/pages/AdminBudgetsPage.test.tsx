import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import { ADMIN_ID, budgetsFixture } from '../test/adminFixtures';
import { baseMe, sessionValue } from '../test/fixtures';
import { TestProviders } from '../test/TestProviders';
import { AdminBudgetsPage } from './AdminBudgetsPage';

function renderPage(api: Partial<ApiClient>, isAdmin = true) {
  return render(
    <TestProviders
      session={sessionValue({
        api: { getBudgets: vi.fn(() => Promise.resolve(budgetsFixture())), ...api } as ApiClient,
        me: { ...baseMe, user_id: ADMIN_ID, is_admin: isAdmin },
      })}
    >
      <AdminBudgetsPage />
    </TestProviders>,
  );
}

function row(rows: HTMLElement[], index: number): HTMLElement {
  const item = rows[index];
  if (!item) throw new Error(`missing row ${String(index)}`);
  return item;
}

const usersSection = async () =>
  (await screen.findByRole('heading', { name: 'Por usuario' })).closest('section') as HTMLElement;

describe('AdminBudgetsPage', () => {
  it('shows defaults, the FinOps agent and users; unavailable parts are "Próximamente"', async () => {
    const { container } = renderPage({});
    expect(await screen.findByRole('heading', { name: 'Valores por defecto' })).toBeInTheDocument();
    expect(screen.getByText('USD 50,00')).toBeInTheDocument();
    expect(screen.getByText('USD 2.000,00')).toBeInTheDocument();
    expect(screen.getByText('1 usuario sin límite propio')).toBeInTheDocument();
    const agents = screen
      .getByRole('heading', { name: /Por agente/ })
      .closest('section') as HTMLElement;
    expect(agents).toHaveTextContent('FinOps');
    expect(agents).toHaveTextContent('Límite por defecto · Al 100%: bloquear');
    // Teams, KPIs and "Nuevo presupuesto" have no backend.
    expect(screen.getAllByText('Próximamente').length).toBeGreaterThanOrEqual(3);
    // "Por equipo" has no budgets: no "USD x de y" total.
    const teams = screen
      .getByRole('heading', { name: /Por equipo/, hidden: true })
      .closest('section') as HTMLElement;
    expect(teams).not.toHaveTextContent(/ de USD/);
    // "Alertas activas" is available (design v14): not "Próximamente", and not clickable.
    const alerts = screen.getByText(/^Alertas activas ·/).closest('.bg-side') as HTMLElement;
    expect(alerts).not.toHaveClass('soon-block');
    expect(within(alerts).queryByText('Próximamente')).toBeNull();
    expect(within(alerts).queryByRole('button')).toBeNull();
    expect(container.querySelector('img, script')).toBeNull();
  });

  it('lists every agent the API returns, by name when it has one', async () => {
    const base = budgetsFixture();
    renderPage({
      getBudgets: vi.fn(() =>
        Promise.resolve({
          ...base,
          agents: [
            ...base.agents,
            {
              agent_id: 'k3fq7zr2m5xw6n4a',
              name: 'Savings <b>Plans</b>',
              limit_usd: '2000.00',
              spent_usd: '12.00',
            },
            { agent_id: 'b6t2hd5yq7lc3vpe', name: null, limit_usd: '2000.00', spent_usd: '3.00' },
          ],
        }),
      ),
    });
    const agents = (await screen.findByRole('heading', { name: /Por agente/ })).closest(
      'section',
    ) as HTMLElement;
    expect(agents).toHaveTextContent('FinOps');
    // The name is creator text: shown as text. Without a name, the id.
    expect(agents).toHaveTextContent('Savings <b>Plans</b>');
    expect(agents).toHaveTextContent('b6t2hd5yq7lc3vpe');
    expect(agents.querySelector('b')).toBeNull();
  });

  it('shows the per-agent pencil as "Próximamente" and colors the alert by state', async () => {
    renderPage({
      getBudgets: vi.fn(() =>
        Promise.resolve(
          budgetsFixture({
            agents: [{ agent_id: 'finops', limit_usd: '2000.00', spent_usd: '1700.00' }],
          }),
        ),
      ),
    });
    const agents = (await screen.findByRole('heading', { name: /Por agente/ })).closest(
      'section',
    ) as HTMLElement;
    // Visible tag and accessible name, like the design's `<Soon on>` around the pencil.
    expect(within(agents).getByText('Próximamente')).toBeInTheDocument();
    expect(within(agents).getByText(/^Editar /)).toHaveClass('sr-only');
    expect(within(agents).queryByRole('button', { name: /^Editar / })).toBeNull();
    const percent = screen.getAllByText('85%').find((node) => node.closest('.bg-alert'));
    expect(percent).toHaveStyle({ color: 'var(--amber)' });
  });

  it('puts your own row first, read-only, and renders emails as text', async () => {
    renderPage({});
    const section = await usersSection();
    const rows = within(section).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('ana.perez@example.com');
    expect(within(row(rows, 0)).getByText('Tú')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('Por defecto · solo lectura');
    expect(
      within(row(rows, 0)).getByRole('button', {
        name: 'Solo lectura: otro administrador debe cambiar tu presupuesto',
      }),
    ).toBeDisabled();
    expect(rows[1]).toHaveTextContent('<img src=x onerror=alert(1)>@example.com');
    expect(within(row(rows, 1)).getByText('Agotado')).toBeInTheDocument();
  });

  it('filters users by search and by state, with counters', async () => {
    const user = userEvent.setup();
    renderPage({});
    const section = await usersSection();
    const filter = within(section).getByRole('combobox', { name: 'Filtrar usuarios' });
    expect(within(filter).getByRole('option', { name: 'Agotados · 1' })).toBeInTheDocument();
    await user.selectOptions(filter, 'out');
    expect(within(section).getAllByRole('listitem')).toHaveLength(1);
    await user.selectOptions(filter, 'all');
    await user.type(within(section).getByRole('textbox', { name: 'Buscar usuario' }), 'zzz');
    expect(
      within(section).getByText('Ningún usuario coincide con la búsqueda.'),
    ).toBeInTheDocument();
  });

  it('edits the defaults with a block warning and saves them', async () => {
    const user = userEvent.setup();
    const putBudgetDefaults = vi.fn(() => Promise.resolve(budgetsFixture({ version: 5 })));
    renderPage({ putBudgetDefaults });
    await user.click(await screen.findByRole('button', { name: 'Editar valores por defecto' }));
    const dialog = screen.getByRole('dialog', { name: 'Valores por defecto' });
    const userLimit = within(dialog).getByLabelText('Límite por usuario');
    await user.clear(userLimit);
    await user.type(userLimit, '10');
    expect(
      within(dialog).getByText(/1 usuario quedaría bloqueado al instante/),
    ).toBeInTheDocument();
    await user.clear(userLimit);
    await user.type(userLimit, '1.500,5');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    expect(putBudgetDefaults).toHaveBeenCalledWith({
      version: 4,
      user_monthly_usd: '1500.50',
      agent_monthly_usd: '2000.00',
    });
    expect(await screen.findByText('Valores por defecto guardados')).toBeInTheDocument();
  });

  it('validates amounts like the design', async () => {
    const user = userEvent.setup();
    const putBudgetDefaults = vi.fn();
    renderPage({ putBudgetDefaults });
    await user.click(await screen.findByRole('button', { name: 'Editar valores por defecto' }));
    const dialog = screen.getByRole('dialog');
    const userLimit = within(dialog).getByLabelText('Límite por usuario');
    await user.clear(userLimit);
    await user.type(userLimit, '12,345');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    expect(within(dialog).getByText('Máximo 2 decimales')).toBeInTheDocument();
    expect(putBudgetDefaults).not.toHaveBeenCalled();
  });

  it('on 409 reloads the current values in the dialog instead of overwriting', async () => {
    const user = userEvent.setup();
    const fresh = budgetsFixture({
      version: 9,
      defaults: { user_monthly_usd: '75.00', agent_monthly_usd: '2000.00' },
    });
    const getBudgets = vi.fn().mockResolvedValueOnce(budgetsFixture()).mockResolvedValueOnce(fresh);
    renderPage({
      getBudgets,
      putBudgetDefaults: vi.fn(() => Promise.reject(new ApiError(409, 'version_conflict', 'x'))),
    });
    await user.click(await screen.findByRole('button', { name: 'Editar valores por defecto' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    expect(
      await within(dialog).findByText('Otro administrador cambió estos datos'),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Límite por usuario')).toHaveValue('75,00');
  });

  it('sets a user limit with the usage preview and shows self_edit from the API', async () => {
    const user = userEvent.setup();
    const putUserBudget = vi.fn(() => Promise.reject(new ApiError(403, 'self_edit', 'x')));
    renderPage({ putUserBudget });
    const section = await usersSection();
    await user.click(within(section).getByRole('button', { name: /^Editar / }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Gastado en 2026-09: USD 160,00');
    expect(dialog).toHaveTextContent('Con este límite quedaría en');
    expect(dialog).toHaveTextContent('Sus próximas consultas se bloquearán hasta el próximo mes.');
    await user.click(within(dialog).getByRole('radio', { name: /Usar el valor por defecto/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    expect(putUserBudget).toHaveBeenCalledWith('c9a0f311-luis', { version: 4, limit_usd: null });
    expect(
      await within(dialog).findByText(/No puedes cambiar algo que te afecta/),
    ).toBeInTheDocument();
  });

  it('confirms going back to the default limit with a success toast, like the design', async () => {
    const user = userEvent.setup();
    const putUserBudget = vi.fn(() => Promise.resolve(budgetsFixture({ version: 5 })));
    renderPage({ putUserBudget });
    const section = await usersSection();
    await user.click(within(section).getByRole('button', { name: /^Editar / }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /Usar el valor por defecto/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    const toast = (
      await screen.findByText('El usuario vuelve a usar el límite por defecto')
    ).closest('.g-toast-item');
    expect(toast).toHaveAttribute('data-tone', 'success');
  });

  it('colors a user bar by the same state as its badge just below the limit', async () => {
    renderPage({
      getBudgets: vi.fn(() =>
        Promise.resolve(
          budgetsFixture({
            users: [
              {
                user_id: 'c9a0f311-luis',
                email: 'luis@example.com',
                limit_usd: '100.00',
                override: true,
                // 99,6 %: shown as "100%", but the limit is not reached yet.
                spent_usd: '99.60',
              },
            ],
          }),
        ),
      ),
    });
    const item = within(await usersSection()).getByRole('listitem');
    expect(within(item).getByText('En alerta')).toBeInTheDocument();
    expect(within(item).getByText('100%')).toHaveStyle({ color: 'var(--amber)' });
  });

  it('explains the action at 100 % on hover and lists the alerts from highest to lowest', async () => {
    renderPage({
      getBudgets: vi.fn(() =>
        Promise.resolve(
          budgetsFixture({
            agents: [
              { agent_id: 'finops', limit_usd: '2000.00', spent_usd: '1700.00' },
              { agent_id: 'otro', limit_usd: '2000.00', spent_usd: '2100.00' },
            ],
          }),
        ),
      ),
    });
    const agents = (await screen.findByRole('heading', { name: /Por agente/ })).closest(
      'section',
    ) as HTMLElement;
    expect(
      within(agents).getAllByText('Límite por defecto · Al 100%: bloquear')[0],
    ).toHaveAttribute(
      'title',
      'Se rechazan las nuevas consultas hasta el próximo mes o hasta ampliar el límite.',
    );
    const alerts = screen.getByText(/^Alertas activas ·/).closest('.bg-side') as HTMLElement;
    expect([...alerts.querySelectorAll('.bg-alert')].map((node) => node.textContent)).toEqual([
      'otro105%',
      'FinOps85%',
    ]);
  });

  it('hides defaults and users while filtering agents, with an empty state', async () => {
    const user = userEvent.setup();
    renderPage({});
    await screen.findByRole('heading', { name: 'Valores por defecto' });
    await user.click(screen.getByRole('button', { name: 'Excedidos' }));
    expect(screen.queryByRole('heading', { name: 'Valores por defecto' })).toBeNull();
    expect(screen.getByText('Nada coincide')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    expect(screen.getByRole('heading', { name: 'Valores por defecto' })).toBeInTheDocument();
  });

  it('shows the design access state to non-admins without calling the API', () => {
    const getBudgets = vi.fn();
    renderPage({ getBudgets }, false);
    expect(screen.getByText('No tienes acceso a esta sección')).toBeInTheDocument();
    expect(getBudgets).not.toHaveBeenCalled();
  });
});
