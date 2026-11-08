import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { definition, version } from '../agentBuilder/testFixtures';
import { CapsSection } from './CapsSection';
import { otherChanges, type Version } from './reviewModel';

const NOTE =
  'La memoria está apagada en esta instalación: aunque se apruebe, el agente no recordará nada hasta que se encienda.';

const change = (diff: Partial<Version['diff']>, def: Partial<Version['definition']> = {}) =>
  version({
    definition: definition(def),
    diff: { is_new: false, fields: [], sets: [], prompt: null, changes: 0, ...diff },
  });

describe('CapsSection (design round 41 `RvCaps`, TM-ME6)', () => {
  it('shows both capabilities of a new agent, on or off', () => {
    render(
      <CapsSection
        version={version({ definition: definition({ memory: true }) })}
        memoryEnabled={false}
      />,
    );
    expect(screen.getByRole('heading', { name: 'capacidades' })).toBeInTheDocument();
    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Ejecutar código');
    expect(rows[0]).toHaveTextContent('Apagada');
    expect(rows[1]).toHaveTextContent('Memoria');
    expect(rows[1]).toHaveTextContent('Encendida');
    // Off in the installation: approving it remembers nothing yet.
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it('shows only what a change turns on or off, from the server diff', () => {
    render(
      <CapsSection
        version={change(
          {
            fields: [{ field: 'memory', before: false, after: true }],
            sets: [{ field: 'capabilities', added: [], removed: ['code_interpreter'] }],
            changes: 2,
          },
          { memory: true },
        )}
        memoryEnabled
      />,
    );
    expect(screen.getByRole('heading', { name: 'capacidades · 2 cambios' })).toBeInTheDocument();
    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Ejecutar código');
    expect(rows[0]).toHaveTextContent('Se apaga');
    expect(rows[1]).toHaveTextContent('Se enciende');
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it('says what the version has when nothing changed', () => {
    render(
      <CapsSection
        version={change({}, { capabilities: ['code_interpreter'], memory: false })}
        memoryEnabled
      />,
    );
    expect(screen.getByRole('heading', { name: 'capacidades · sin cambios' })).toBeInTheDocument();
    expect(screen.getByText('Ejecutar código: sí · Memoria: no.')).toBeInTheDocument();
  });

  it('leaves no capability change to «otros cambios» but an unknown one', () => {
    const shown = otherChanges({
      is_new: false,
      fields: [{ field: 'memory', before: false, after: true }],
      sets: [{ field: 'capabilities', added: ['code_interpreter'], removed: [] }],
      prompt: null,
      changes: 2,
    });
    expect(shown).toEqual({ fields: [], sets: [] });
    const unknown = otherChanges({
      is_new: false,
      fields: [],
      sets: [{ field: 'capabilities', added: ['browser'], removed: [] }],
      prompt: null,
      changes: 1,
    });
    expect(unknown.sets).toHaveLength(1);
  });
});
