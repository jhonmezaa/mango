import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TestProviders } from '../../test/TestProviders';
import { list, skill } from '../skills/testFixtures';
import { SkillsSection } from './SkillsSection';

const SKILLS = list([
  skill({ version: 3 }),
  skill({ id: 'precios', name: 'Precios', version: 1 }),
  skill({
    id: 'facturas',
    name: 'Facturas',
    version: 2,
    available: false,
    servers: [
      { id: 'billing', name: 'Billing', enabled: false, data_tier: null, tools: 1, writes: false },
    ],
  }),
]);

function renderSection(props: Partial<Parameters<typeof SkillsSection>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <TestProviders>
      <SkillsSection
        selected={[]}
        skills={SKILLS}
        tools={['cost-explorer.per_user']}
        onChange={onChange}
        {...props}
      />
    </TestProviders>,
  );
  return { onChange, user: userEvent.setup() };
}

describe('SkillsSection (design SkAgentSection)', () => {
  it('adds a skill at its latest approved version; one with a server off cannot be chosen', async () => {
    const { onChange, user } = renderSection();
    expect(
      screen.getByText(
        'Sin skills. El agente responde solo con su prompt, sus tools y sus knowledge bases.',
      ),
    ).toBeVisible();
    const select = screen.getByRole('combobox', { name: 'Agregar skill' });
    expect(
      within(select).getByRole('option', { name: 'Facturas · v2 · MCP no habilitado' }),
    ).toHaveProperty('disabled', true);
    await user.selectOptions(select, 'revision-de-costos@3');
    expect(onChange).toHaveBeenCalledWith({ skills: ['revision-de-costos@3'] });
    expect(screen.getByText('0 de 10')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Ver catálogo de skills' })).toHaveAttribute(
      'href',
      '/skills',
    );
  });

  it('pins a version: offers the newer one, and removes', async () => {
    const { onChange, user } = renderSection({ selected: ['revision-de-costos@2'] });
    expect(screen.getByText('revision-de-costos@v2')).toBeVisible();
    expect(screen.getByText('v3 disponible')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Pasar a v3' }));
    expect(onChange).toHaveBeenLastCalledWith({ skills: ['revision-de-costos@3'] });
    await user.click(screen.getByRole('button', { name: 'Quitar Revisión de costos' }));
    expect(onChange).toHaveBeenLastCalledWith({ skills: [] });
    // Already chosen: not offered again.
    expect(screen.queryByRole('option', { name: /Revisión de costos/ })).toBeNull();
  });

  it('says why a skill cannot be sent', () => {
    renderSection({
      selected: ['revision-de-costos@9', 'facturas@2', 'precios@1'],
      tools: [],
    });
    expect(
      screen.getByText(
        'La skill Revisión de costos v9 ya no está aprobada. Pásala a la última versión o quítala.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        'La skill Facturas requiere Billing, que no está habilitado. Quítala o pide que lo habiliten.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        'La skill Precios requiere AWS Cost Explorer y el agente no tiene ninguna de sus tools. Agrega una o quita la skill.',
      ),
    ).toHaveClass('is-warn');
  });

  it('stops at the maximum', () => {
    renderSection({
      selected: Array.from({ length: 10 }, (_, i) => `s${String(i)}@1`),
      skills: { ...SKILLS, max_per_agent: 10 },
    });
    expect(screen.getByRole('combobox', { name: 'Agregar skill' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Ya tiene 10 skills, el máximo' })).toBeVisible();
  });

  it('without the list keeps what the version has and offers to retry', () => {
    renderSection({ skills: null, selected: ['revision-de-costos@3'] });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No se pudieron cargar las skills. Las que ya tiene el agente se conservan.',
    );
    expect(screen.getByText('revision-de-costos@v3')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Agregar skill' })).toBeDisabled();
  });
});
