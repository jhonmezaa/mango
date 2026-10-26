import { describe, expect, it } from 'vitest';

import {
  NO_FILTERS,
  changedFields,
  copyName,
  draftErrors,
  filtered,
  instructionParts,
  lineDiff,
  pendingNew,
  skillIdOf,
  variablesOf,
  type Draft,
} from './model';
import { change, list, skill } from './testFixtures';

const DRAFT: Draft = {
  name: 'Revisión de costos',
  category: 'FinOps',
  description: '',
  instructions: 'Consulta {{período}}',
  outputs: [],
  servers: ['cost-explorer'],
};
const OPTIONS = {
  isNew: true,
  takenIds: new Set<string>(),
  enabledServers: new Set(['cost-explorer']),
};

describe('instructions', () => {
  it('finds each {{variable}} once, trimmed', () => {
    expect(variablesOf('{{ a }} y {{b}} y {{a}}')).toEqual(['a', 'b']);
    expect(variablesOf('sin variables')).toEqual([]);
  });

  it('splits the text into parts, marking variables (rendered as text)', () => {
    expect(instructionParts('<b>x</b> {{v}}!')).toEqual([
      { text: '<b>x</b> ', variable: false },
      { text: '{{v}}', variable: true },
      { text: '!', variable: false },
    ]);
  });

  it('derives the id the API gives a new skill', () => {
    expect(skillIdOf('Revisión de Costos (copia)')).toBe('revision-de-costos-copia');
    expect(skillIdOf('  --  ')).toBe('');
    expect(skillIdOf('a'.repeat(39) + ' b')).toBe('a'.repeat(39));
  });

  it('keeps the name of a copy within 48 characters', () => {
    expect(copyName('x'.repeat(48), ' (copia)')).toHaveLength(48);
    expect(copyName('Costos', ' (copia)')).toBe('Costos (copia)');
  });
});

describe('lineDiff', () => {
  it('marks added, removed and kept lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      [' ', 'a'],
      ['-', 'b'],
      ['+', 'B'],
      [' ', 'c'],
      ['+', 'd'],
    ]);
  });

  it('does not build a huge table: past the limit the middle is removed and added', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `a${String(i)}`).join('\n');
    const after = Array.from({ length: 2000 }, (_, i) => `b${String(i)}`).join('\n');
    const diff = lineDiff(`head\n${before}\ntail`, `head\n${after}\ntail`);
    expect(diff).toHaveLength(4002);
    expect(diff[0]).toEqual([' ', 'head']);
    expect(diff[1]).toEqual(['-', 'a0']);
    expect(diff[2001]).toEqual(['+', 'b0']);
    expect(diff.at(-1)).toEqual([' ', 'tail']);
  });
});

describe('catalog', () => {
  it('filters by text (name, description, server), category, level and availability', () => {
    const items = [
      skill(),
      skill({
        id: 'b',
        name: 'Precios',
        category: 'DevOps',
        data_tier: 'public',
        available: false,
      }),
    ];
    expect(filtered(items, { ...NO_FILTERS, query: 'cost-explorer' })).toHaveLength(2);
    expect(filtered(items, { ...NO_FILTERS, query: 'precios' }).map((s) => s.id)).toEqual(['b']);
    expect(filtered(items, { ...NO_FILTERS, category: 'DevOps' })).toHaveLength(1);
    expect(filtered(items, { ...NO_FILTERS, level: 'public' })).toHaveLength(1);
    expect(filtered(items, { ...NO_FILTERS, availability: 'off' }).map((s) => s.id)).toEqual(['b']);
  });

  it('lists the first proposals still open whose skill does not exist yet', () => {
    const data = list([skill()], {
      changes: [
        change({ version: 1, skill_id: 'nueva' }),
        change({ version: 1, skill_id: 'cerrada', status: 'rejected' }),
        change(),
      ],
    });
    expect(pendingNew(data).map((c) => c.skill_id)).toEqual(['nueva']);
  });
});

describe('draftErrors', () => {
  it('accepts a complete draft', () => {
    expect(draftErrors(DRAFT, 'motivo', OPTIONS)).toEqual([]);
  });

  it('reports each missing or invalid field, in the design order', () => {
    expect(
      draftErrors(
        {
          ...DRAFT,
          name: ' ',
          instructions: '',
          servers: [],
        },
        '',
        OPTIONS,
      ),
    ).toEqual(['name', 'instructions', 'servers', 'reason']);
  });

  it('finds a secret, a disabled server, too many items and a taken id', () => {
    const errors = draftErrors(
      {
        ...DRAFT,
        instructions: 'api_key = ' + 'A'.repeat(24),
        servers: ['cost-explorer', 'apagado'],
        outputs: Array.from({ length: 11 }, (_, i) => String(i)),
      },
      'motivo',
      { ...OPTIONS, takenIds: new Set(['revision-de-costos']) },
    );
    expect(errors).toEqual(['secret', 'tooManyOutputs', 'serversOff', 'exists']);
  });

  it('does not check the id of a new version', () => {
    expect(
      draftErrors(DRAFT, 'motivo', {
        ...OPTIONS,
        isNew: false,
        takenIds: new Set(['revision-de-costos']),
      }),
    ).toEqual([]);
  });
});

describe('changedFields', () => {
  it('lists only what the request changes', () => {
    const current = {
      name: 'Revisión de costos',
      category: 'FinOps',
      description: 'Resume el gasto del período',
      outputs: ['tabla'],
      servers: ['cost-explorer', 'aws-pricing'],
    };
    expect(changedFields(current, change())).toEqual([
      { field: 'servers', before: 'cost-explorer, aws-pricing', after: 'cost-explorer' },
    ]);
  });
});
