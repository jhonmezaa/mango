import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogRemote } from './model';
import { RemoteTools } from './RemoteTools';

const REF = 'remote-abcdefghij23.wit_work_item';
const remote: CatalogRemote = {
  id: 'remote-abcdefghij23',
  registration_id: 'abcdefghij23',
  service: 'Azure DevOps',
  operator: 'Microsoft',
  organization: 'empresa',
  tools: [
    {
      ref: REF,
      name: 'wit_work_item',
      description: 'Lee un work item',
      access: 'read',
      audience: 'all',
      central_groups_only: false,
      enabled: true,
      requires_service: null,
      unclassified: false,
    },
  ],
};
const audience = [
  {
    registration_id: 'abcdefghij23',
    service: 'Azure DevOps',
    groups_without_access: ['bu-retail'],
  },
];

describe('RemoteTools (design RemoteBuilderTools)', () => {
  it('lists the read tools of each registration and toggles them', async () => {
    const onChange = vi.fn();
    render(
      <RemoteTools
        tools={[]}
        remotes={[remote]}
        audience={[]}
        groups={[]}
        userCount={0}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('servicio externo · empresa')).toBeInTheDocument();
    expect(screen.getByText('Los datos salen de AWS')).toBeInTheDocument();
    expect(
      screen.getByText('Lee un work item · lee con la cuenta de cada persona'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /wit_work_item/ }));
    expect(onChange).toHaveBeenCalledWith([REF]);
    await userEvent.click(screen.getByRole('button', { name: 'Todas' }));
    expect(onChange).toHaveBeenLastCalledWith([REF]);
  });

  it('warns, without blocking, about groups and people without the service (P-2)', () => {
    render(
      <RemoteTools
        tools={[REF]}
        remotes={[remote]}
        audience={audience}
        groups={['bu-retail', 'finops-central']}
        userCount={2}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Este agente es visible para grupos que no tienen Azure DevOps/),
    ).toHaveTextContent(
      'Este agente es visible para grupos que no tienen Azure DevOps (bu-retail) y personas sueltas. Esas personas no podrán conectar su cuenta: el agente les responderá sin estas tools.',
    );
  });

  it('shows nothing without registrations', () => {
    const { container } = render(
      <RemoteTools
        tools={[]}
        remotes={[]}
        audience={[]}
        groups={[]}
        userCount={0}
        onChange={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
