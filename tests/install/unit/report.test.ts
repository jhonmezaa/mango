import { describe, expect, it } from 'vitest';

import { createRedactor } from '../src/redact.ts';
import { describeError, renderReport } from '../src/report.ts';

describe('describeError', () => {
  it('masks a failure message and drops the colors', () => {
    const redact = createRedactor([{ value: 'admin-prueba@empresa.com', label: 'admin' }]);
    const message = `\u001b[31mExpected\u001b[39m "admin-prueba@empresa.com" in account 111122223333`;
    expect(describeError({ message }, redact)).toBe('Expected "<admin>" in account <cuenta>');
  });
});

describe('renderReport', () => {
  const line = { seconds: 1, errors: [], skipped: [], leaves: [], notes: [] };
  const report = renderReport({
    url: 'https://d***.example.net',
    startedAt: '2026-10-05T20:00:00.000Z',
    seconds: 42,
    outcome: 'pasó',
    release: 'v0.1.0-g0000000',
    agents: '«FinOps» publicado y servido (visto como «areaMember»)',
    roles: { admin: true, plain: false },
    effects: { chat: false, people: true },
    lines: [
      {
        ...line,
        title: 'sign-in',
        file: '02-session.spec.ts',
        status: 'passed',
        leaves: ['Una sesión.'],
      },
      {
        ...line,
        title: 'as plain',
        file: '03-access.spec.ts',
        status: 'skipped',
        skipped: ['sin usuario'],
      },
      { ...line, title: 'audit', file: '04-audit.spec.ts', status: 'failed', errors: ['boom'] },
    ],
  });

  it('says the masked URL, the release, what passed, what was skipped and why', () => {
    expect(report).toContain('**Instalación:** https://d***.example.net');
    expect(report).toContain('**Release que muestra:** v0.1.0-g0000000');
    expect(report).toContain(
      '**Agentes de la versión:** «FinOps» publicado y servido (visto como «areaMember»)',
    );
    expect(report).toContain('1 pasaron, 1 fallaron, 1 se saltaron');
    expect(report).toContain('- as plain: sin usuario');
    expect(report).toContain('admin sí, plain no');
    expect(report).toContain('chat no, people sí');
  });

  it('lists the failures with their message and what the run left behind', () => {
    expect(report).toContain('### audit\n\n```\nboom\n```');
    expect(report).toContain('- Una sesión. _(sign-in)_');
  });
});
