import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../api/client';
import { agentFixture, sessionValue } from '../../test/fixtures';
import { TestProviders } from '../../test/TestProviders';
import { ToolsPopover } from './ToolsPopover';

const AGENT = agentFixture({
  name: 'FinOps <b>',
  tools: ['cost-explorer.get_cost_and_usage', 'cost-explorer.get_forecast', 'budgets.describe'],
});
const SKILLS = [
  {
    id: 'revision-de-costos',
    version: 3,
    name: 'Revisión <i>de costos</i>',
    description: 'Resume el gasto <img src=x onerror=alert(1)>',
  },
];

function setup(answers: unknown[]) {
  const call = vi.fn<(operation: string, input?: unknown) => Promise<unknown>>(() => {
    const answer = answers.shift();
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  render(
    <TestProviders session={sessionValue({ api: { call } as unknown as ApiClient })}>
      <ToolsPopover agent={AGENT} />
    </TestProviders>,
  );
  return { call, user: userEvent.setup() };
}

const trigger = () => screen.getByRole('button', { name: 'Skills y tools disponibles' });

describe('ToolsPopover', () => {
  it('asks for the detail only when it opens and lists the skills as text', async () => {
    const { call, user } = setup([{ ...AGENT, skills: SKILLS }]);
    expect(call).not.toHaveBeenCalled();
    // Design round 24: both counters say «–» until it is read.
    expect(trigger()).toHaveTextContent('– · –');
    await user.click(trigger());
    expect(call).toHaveBeenCalledWith('getAgent', { path: { agent_id: 'finops' } });
    const pop = screen.getByRole('dialog', { name: 'Qué puede usar FinOps <b>' });
    expect(await within(pop).findByText('Revisión <i>de costos</i>')).toBeInTheDocument();
    expect(within(pop).getByText('v3')).toBeInTheDocument();
    expect(within(pop).getByText('Skills · 1')).toBeInTheDocument();
    expect(within(pop).getByText(/Resume el gasto/)).toBeInTheDocument();
    expect(pop.querySelector('img, b, i')).toBeNull();
    // Tools by MCP server, without the design's latency or health.
    expect(within(pop).getByText('Tools (MCP) · 2')).toBeInTheDocument();
    expect(within(pop).getByText('2 tools')).toBeInTheDocument();
    expect(within(pop).getByText('1 tool')).toBeInTheDocument();
    expect(trigger()).toHaveTextContent('1 · 2');
    // Closing and opening again reads nothing more.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(trigger());
    expect(call).toHaveBeenCalledOnce();
  });

  it('says when the version has no skills', async () => {
    const { user } = setup([{ ...AGENT, skills: [] }]);
    await user.click(trigger());
    expect(await screen.findByText('Esta versión no tiene skills.')).toBeInTheDocument();
  });

  it('offers to retry when the skills could not be read', async () => {
    const { call, user } = setup([
      new Error('down'),
      { ...AGENT, skills: null },
      { ...AGENT, skills: SKILLS },
    ]);
    await user.click(trigger());
    expect(
      await screen.findByText('No se pudo cargar qué puede usar FinOps <b>'),
    ).toBeInTheDocument();
    expect(screen.getByText('Inténtalo de nuevo en unos segundos.')).toBeInTheDocument();
    expect(trigger()).toHaveTextContent('– · –');
    // A detail without skills (the registry was down) is the same failure.
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Revisión <i>de costos</i>')).toBeInTheDocument();
    expect(call).toHaveBeenCalledTimes(3);
  });
});
