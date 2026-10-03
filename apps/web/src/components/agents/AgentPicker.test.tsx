import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../agents/agents';
import { agentFixture, finopsAgent } from '../../test/fixtures';
import { AgentPicker } from './AgentPicker';

const SALES = agentFixture({
  id: 'abcdefghijklmnop',
  name: 'Ventas <b>LATAM</b>',
  description: 'Pipeline <img src=x onerror=alert(1)>',
  category: 'Comercial',
  model: 'model-b',
});
const TAGS = agentFixture({ id: 'p2ys6ke4c7dq3hzo', name: 'Etiquetado', category: 'Comercial' });
const RETIRED = agentFixture({ id: 'qrstuvwxyz234567', name: 'Viejo', status: 'retired' });
const NO_CATEGORY = agentFixture({ id: 'h5cu4n6sl2we7ygt', name: 'Suelto', category: '' });

function renderPicker(
  props: Partial<Parameters<typeof AgentPicker>[0]> = {},
  agents: Agent[] = [finopsAgent, SALES, TAGS, RETIRED, NO_CATEGORY],
) {
  const handlers = { onPick: vi.fn(), onCreate: vi.fn(), onMarketplace: vi.fn(), onClose: vi.fn() };
  render(
    <AgentPicker agents={agents} recentAgentIds={[]} canCreate={false} {...handlers} {...props} />,
  );
  return handlers;
}

const cards = (root: HTMLElement = document.body) =>
  [...root.querySelectorAll('.picker-card-name')].map((node) => node.textContent);

describe('AgentPicker', () => {
  it('lists the agents the user can chat with, as text, without the retired ones', () => {
    renderPicker();
    const dialog = screen.getByRole('dialog', { name: 'Nueva conversación' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Elige el agente con el que quieres conversar')).toBeInTheDocument();
    expect(cards()).toEqual(['FinOps', 'Ventas <b>LATAM</b>', 'Etiquetado', 'Suelto']);
    expect(dialog.querySelector('b, img')).toBeNull();
    expect(screen.getByText('Comercial · model-b')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Todos los agentes' })).toBeInTheDocument();
  });

  it('filters by category, with counts', async () => {
    const user = userEvent.setup();
    renderPicker();
    expect(screen.getByRole('button', { name: 'Todos 4' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Comercial 2' }));
    expect(cards()).toEqual(['Ventas <b>LATAM</b>', 'Etiquetado']);
    expect(screen.getByRole('heading', { name: 'Comercial' })).toBeInTheDocument();
  });

  it('searches by name, description and category', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.type(screen.getByRole('searchbox', { name: 'Buscar agentes' }), '  PIPELINE ');
    expect(cards()).toEqual(['Ventas <b>LATAM</b>']);
    expect(screen.getByRole('heading', { name: 'Resultados (1)' })).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), '<script>');
    expect(cards()).toEqual([]);
    expect(screen.getByText('Sin agentes que coincidan con "<script>"')).toBeInTheDocument();
  });

  it('shows the recently used agents first, at most four, only the usable ones', () => {
    renderPicker({
      recentAgentIds: ['p2ys6ke4c7dq3hzo', 'qrstuvwxyz234567', 'finops', 'p2ys6ke4c7dq3hzo', 'zz'],
    });
    const recent = screen.getByRole('region', { name: 'Recientes' });
    expect(cards(recent)).toEqual(['Etiquetado', 'FinOps']);
    // Mini cards carry no description.
    expect(recent.querySelector('.picker-card-desc')).toBeNull();
  });

  it('hides the recent ones while searching or filtering', async () => {
    const user = userEvent.setup();
    renderPicker({ recentAgentIds: ['finops'] });
    await user.type(screen.getByRole('searchbox'), 'fin');
    expect(screen.queryByRole('region', { name: 'Recientes' })).toBeNull();
  });

  it('picks an agent', async () => {
    const user = userEvent.setup();
    const { onPick } = renderPicker();
    await user.click(screen.getByRole('button', { name: /Etiquetado/ }));
    expect(onPick).toHaveBeenCalledWith(TAGS);
  });

  it('closes with Escape, the close button and the backdrop', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPicker();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Cerrar' }));
    const overlay = document.querySelector<HTMLElement>('.picker-overlay');
    if (!overlay) throw new Error('no overlay');
    await user.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(3);
    // A click inside the dialog does not close it.
    await user.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('offers «Crear nuevo agente» only to who may create agents', async () => {
    const user = userEvent.setup();
    const { onMarketplace } = renderPicker();
    expect(screen.queryByRole('button', { name: 'Crear nuevo agente' })).toBeNull();
    // Design ui.jsx (oct 2026): who cannot create is sent to the Marketplace instead.
    expect(screen.getByText('¿No encuentras el agente correcto?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ver Marketplace' }));
    expect(onMarketplace).toHaveBeenCalledOnce();

    const { onCreate } = renderPicker({ canCreate: true }, [finopsAgent]);
    const creator = within(screen.getAllByRole('dialog')[1] as HTMLElement);
    expect(creator.queryByRole('button', { name: 'Ver Marketplace' })).toBeNull();
    await user.click(creator.getByRole('button', { name: 'Crear nuevo agente' }));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('says so when there is nothing to choose', () => {
    renderPicker({}, [RETIRED]);
    expect(screen.getByText('Todavía no tienes agentes disponibles.')).toBeInTheDocument();
  });
});
