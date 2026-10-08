import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import example from '../config.example.json' with { type: 'json' };
import {
  isActive,
  judge,
  releaseAgents,
  reportLine,
  WHERE_TO_LOOK,
  type Evidence,
  type Listed,
  type Verdict,
} from '../src/agents.ts';

const finops = { id: 'finops', name: 'FinOps' };
const published: Listed = { status: 'published', retired_at: null };
const retired: Listed = { status: 'retired', retired_at: '2026-10-01T00:00:00+00:00' };
const ok = { role: 'areaMember', status: 200, code: null, agentStatus: 'published' };

/** What the run gathered, starting from nothing: nobody lists the agent and nobody is admin. */
function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    listed: [
      { role: 'areaMember', item: undefined },
      { role: 'plain', item: undefined },
    ],
    served: undefined,
    admin: undefined,
    ...over,
  };
}
const usable = [
  { role: 'areaMember', item: published },
  { role: 'plain', item: undefined },
];
const why = (verdict: Verdict): string => (verdict.kind === 'broken' ? verdict.why : '');
const review = (status: string, failed_step: string | null = null, retryable = false) => ({
  inTree: false,
  review: { status, failed_step, retryable },
});

describe('releaseAgents', () => {
  const root = mkdtempSync(join(tmpdir(), 'install-check-agents-'));
  afterAll(() => {
    rmSync(root, { recursive: true });
  });
  const write = (id: string, content: string) => {
    mkdirSync(join(root, 'agents', id), { recursive: true });
    writeFileSync(join(root, 'agents', id, 'agent.json'), content);
  };

  it('reads the agents of this repository, the one of the example configuration among them', () => {
    const shipped = releaseAgents();
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.map((agent) => agent.name)).toContain(example.chat.agent);
  });

  it('lists one agent per directory, in order', () => {
    write('zeta', JSON.stringify({ id: 'zeta', definition: { name: 'Zeta', tools: [] } }));
    write('alfa', JSON.stringify({ id: 'alfa', definition: { name: 'Alfa' } }));
    writeFileSync(join(root, 'agents', 'README.md'), 'not an agent');
    expect(releaseAgents(root)).toEqual([
      { id: 'alfa', name: 'Alfa' },
      { id: 'zeta', name: 'Zeta' },
    ]);
  });

  it('refuses a file that declares another agent, or none', () => {
    write('otro', JSON.stringify({ id: 'alfa', definition: { name: 'Otro' } }));
    expect(() => releaseAgents(root)).toThrow('agents/otro/agent.json does not declare');
    write('otro', '{');
    expect(() => releaseAgents(root)).toThrow('agents/otro/agent.json cannot be read');
  });
});

describe('judge', () => {
  it('is served when somebody has it active and the detail answers with the published version', () => {
    const verdict = judge(
      finops,
      evidence({ listed: usable, served: { ...ok, unavailableTools: 2 } }),
    );
    expect(verdict).toEqual({
      kind: 'served',
      by: 'areaMember',
      unavailableTools: 2,
      failedUpdate: null,
    });
  });

  it('is broken when the Marketplace lists it and the chat would not serve it', () => {
    const served = {
      ...ok,
      status: 503,
      code: 'agent_unavailable',
      agentStatus: null,
      unavailableTools: 0,
    };
    const verdict = judge(finops, evidence({ listed: usable, served }));
    expect(why(verdict)).toContain('GET /api/agents/finops answered 503 agent_unavailable');
  });

  it('is broken when nobody has it: the installation that passed with no agent at all', () => {
    const failed = judge(finops, evidence({ admin: review('failed', 'check_harness', true) }));
    expect(failed).toEqual({
      kind: 'broken',
      why: '«FinOps» is not published: its publication failed at the step `check_harness`.',
    });
    const publishing = judge(finops, evidence({ admin: review('approved') }));
    expect(why(publishing)).toContain('has not finished publishing');
    const stuck = judge(finops, evidence({ admin: review('approved', null, true) }));
    expect(why(stuck)).toContain('is no longer publishing it');
    const missing = judge(finops, evidence({ admin: { inTree: false, review: undefined } }));
    expect(why(missing)).toContain('did not seed it');
  });

  it('is broken, and says why, when the run cannot prove it', () => {
    const noUser = judge(
      finops,
      evidence({ admin: { inTree: true, review: review('published').review } }),
    );
    expect(why(noUser)).toContain('no test user of the configuration');
    const noAdmin = judge(finops, evidence());
    expect(why(noAdmin)).toContain('«admin»');
  });

  it('is not a failure when somebody retired it', () => {
    const listed = [{ role: 'admin', item: retired }];
    expect(judge(finops, evidence({ listed }))).toEqual({ kind: 'retired' });
    expect(judge(finops, evidence({ admin: review('retired') }))).toEqual({ kind: 'retired' });
  });

  it('notes an update whose publication failed while the version before it serves', () => {
    const verdict = judge(
      finops,
      evidence({
        listed: usable,
        served: { ...ok, unavailableTools: 0 },
        admin: { inTree: true, review: review('failed', 'update_harness').review },
      }),
    );
    expect(verdict).toMatchObject({ kind: 'served', failedUpdate: 'update_harness' });
  });
});

describe('isActive', () => {
  it('is a published agent nobody retired', () => {
    expect(isActive(published)).toBe(true);
    expect(isActive(retired)).toBe(false);
    expect(isActive({ status: 'published', retired_at: '2026-10-01T00:00:00+00:00' })).toBe(false);
  });
});

describe('reportLine and WHERE_TO_LOOK', () => {
  it('writes one line per agent for the report', () => {
    const served = {
      kind: 'served',
      by: 'areaMember',
      unavailableTools: 0,
      failedUpdate: null,
    } as const;
    expect(reportLine(finops, served)).toBe(
      '«FinOps» publicado y servido (visto como «areaMember»)',
    );
    expect(
      reportLine(finops, { ...served, unavailableTools: 7, failedUpdate: 'check_harness' }),
    ).toBe(
      '«FinOps» publicado y servido (visto como «areaMember»); 7 de sus tools no están ' +
        'disponibles (su pack no está instalado); su última publicación falló en el paso ' +
        '«check_harness» y se sirve la versión anterior',
    );
    expect(reportLine(finops, { kind: 'retired' })).toContain('retirado');
    expect(reportLine(finops, { kind: 'broken', why: 'x' })).toBe(
      '«FinOps» no está publicado y servido',
    );
  });

  it('tells whoever installs where to look, with placeholders only', () => {
    expect(WHERE_TO_LOOK).toContain('Mango-<ns>-AgentProvisioner-failed');
    expect(WHERE_TO_LOOK).toContain('docs/runbooks/install.md');
    expect(WHERE_TO_LOOK).not.toMatch(/\d{12}|arn:aws/);
  });
});
