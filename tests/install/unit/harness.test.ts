import { describe, expect, it } from 'vitest';

import type { Account } from '../src/aws.ts';
import {
  errorCode,
  HARNESS_WHERE_TO_LOOK,
  harnessName,
  harnessOf,
  harnessProblem,
  harnessReport,
  listHarnesses,
  type HarnessState,
} from '../src/harness.ts';

const account: Account = { profile: 'mango', region: 'us-east-1' };
const NAME = 'Mango_acme_a_finops';
const ID = `${NAME}-AbCdEfGhIj`;

/** What the AWS CLI rejects with: the service error is named in its stderr. */
const refused = (code: string) =>
  Object.assign(new Error('Command failed'), {
    stderr: `\nAn error occurred (${code}) when calling the X operation: arn:aws:iam::111122223333:role/r is not allowed\n`,
  });

function cli(answers: Record<string, string | Error>) {
  const calls: string[][] = [];
  const run = (_account: Account, args: string[]) => {
    calls.push(args);
    const answer = answers[args[1] ?? ''];
    if (answer === undefined) return Promise.reject(new Error('unexpected call'));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { run, calls };
}

const listing = (status = 'READY') =>
  JSON.stringify({
    harnesses: [
      { harnessId: ID, harnessName: NAME, status, arn: 'x' },
      { harnessId: 'Mango_other_a_finops-AbCdEfGhIj', harnessName: 'Mango_other_a_finops', status },
    ],
  });
const live = (status: string) => JSON.stringify({ endpoint: { status, liveVersion: '3' } });

async function state(answers: Record<string, string | Error>): Promise<HarnessState> {
  const { run } = cli(answers);
  const listed = await listHarnesses(account, run);
  if (!(listed instanceof Map)) return { kind: 'unknown', code: listed.code };
  return harnessOf(account, listed, NAME, run);
}

describe('harnessName', () => {
  it('is the name the provisioner gives the harness of an agent', () => {
    expect(harnessName('acme', 'finops')).toBe(NAME);
  });
});

describe('the harness of a served agent', () => {
  it('is ready when the harness and its live endpoint are', async () => {
    const { run, calls } = cli({
      'list-harnesses': listing(),
      'get-harness-endpoint': live('READY'),
    });
    const listed = await listHarnesses(account, run);
    expect(listed).toBeInstanceOf(Map);
    expect(await harnessOf(account, listed as never, NAME, run)).toEqual({ kind: 'ready' });
    // Reads only, and the endpoint asked is the one the chat invokes.
    expect(calls.map((args) => args[1])).toEqual(['list-harnesses', 'get-harness-endpoint']);
    expect(calls[1]).toEqual([
      'bedrock-agentcore-control',
      'get-harness-endpoint',
      '--harness-id',
      ID,
      '--endpoint-name',
      'live',
    ]);
  });

  it('is missing when AgentCore lists no harness of that exact name', async () => {
    const other = JSON.stringify({
      harnesses: [{ harnessId: 'x', harnessName: `${NAME}2`, status: 'READY' }],
    });
    expect(await state({ 'list-harnesses': other })).toEqual({ kind: 'missing', what: 'harness' });
    expect(await state({ 'list-harnesses': '{"harnesses":[]}' })).toEqual({
      kind: 'missing',
      what: 'harness',
    });
  });

  it('is missing when the harness has no live endpoint', async () => {
    expect(
      await state({
        'list-harnesses': listing(),
        'get-harness-endpoint': refused('ResourceNotFoundException'),
      }),
    ).toEqual({ kind: 'missing', what: 'endpoint' });
  });

  it.each(['DELETING', 'CREATE_FAILED', 'UPDATING'])('is not ready while %s', async (status) => {
    expect(await state({ 'list-harnesses': listing(status) })).toEqual({
      kind: 'not-ready',
      what: 'harness',
      status,
    });
    expect(
      await state({ 'list-harnesses': listing(), 'get-harness-endpoint': live(status) }),
    ).toEqual({ kind: 'not-ready', what: 'endpoint', status });
  });

  it('is unknown, never ready, when AgentCore cannot be asked', async () => {
    expect(await state({ 'list-harnesses': refused('AccessDeniedException') })).toEqual({
      kind: 'unknown',
      code: 'AccessDeniedException',
    });
    expect(
      await state({
        'list-harnesses': listing(),
        'get-harness-endpoint': refused('ThrottlingException'),
      }),
    ).toEqual({ kind: 'unknown', code: 'ThrottlingException' });
    expect(await state({ 'list-harnesses': 'not json' })).toEqual({
      kind: 'unknown',
      code: 'UnreadableAnswer',
    });
    expect(await state({ 'list-harnesses': '{"other":1}' })).toEqual({
      kind: 'unknown',
      code: 'UnreadableAnswer',
    });
    expect(
      await state({ 'list-harnesses': listing(), 'get-harness-endpoint': '{"endpoint":{}}' }),
    ).toEqual({ kind: 'unknown', code: 'UnreadableAnswer' });
  });
});

describe('errorCode', () => {
  it('keeps the name of the error and nothing else the CLI printed', () => {
    expect(errorCode(refused('ExpiredTokenException'))).toBe('ExpiredTokenException');
    expect(errorCode(Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' }))).toBe(
      'NoAwsCli',
    );
    expect(errorCode(Object.assign(new Error('x'), { stderr: 'aws: error: invalid choice' }))).toBe(
      'CommandFailed',
    );
    expect(errorCode(new Error('anything'))).toBe('CommandFailed');
  });
});

describe('harnessProblem', () => {
  it('is nothing for a harness that is ready', () => {
    expect(harnessProblem('FinOps', { kind: 'ready' })).toBeNull();
  });

  it('says the agent is served but cannot answer', () => {
    expect(harnessProblem('FinOps', { kind: 'missing', what: 'harness' })).toMatch(
      /«FinOps» is published and the application serves it, but AgentCore has no harness/,
    );
    expect(harnessProblem('FinOps', { kind: 'missing', what: 'endpoint' })).toMatch(
      /no `live` endpoint/,
    );
    expect(
      harnessProblem('FinOps', { kind: 'not-ready', what: 'harness', status: 'DELETING' }),
    ).toMatch(/harness is DELETING in AgentCore, not READY/);
  });

  it('fails when it could not ask, and says how to ask or how to skip the question', () => {
    const why = harnessProblem('FinOps', { kind: 'unknown', code: 'AccessDeniedException' });
    expect(why).toMatch(/could not ask AgentCore.*\(AccessDeniedException\)/);
    expect(why).toMatch(/bedrock-agentcore:ListHarnesses/);
    expect(why).toMatch(/bedrock-agentcore:GetHarnessEndpoint/);
    expect(why).toMatch(/remove `aws.namespace`/);
  });

  it('never carries an account id or an ARN', () => {
    const texts = [
      HARNESS_WHERE_TO_LOOK,
      harnessProblem('FinOps', { kind: 'unknown', code: errorCode(refused('AccessDenied')) }),
    ];
    for (const text of texts) expect(text).not.toMatch(/\d{12}|arn:aws/);
  });
});

describe('harnessReport', () => {
  const missing: HarnessState = { kind: 'missing', what: 'harness' };
  const unknown: HarnessState = { kind: 'unknown', code: 'AccessDeniedException' };

  it('fails with nothing and says the harness exists when every one is ready', () => {
    expect(harnessReport([{ agentName: 'FinOps', state: { kind: 'ready' } }])).toEqual({
      line: 'su harness existe en AgentCore',
      failure: [],
    });
  });

  it.each<HarnessState>([
    missing,
    { kind: 'missing', what: 'endpoint' },
    { kind: 'not-ready', what: 'harness', status: 'DELETING' },
    { kind: 'not-ready', what: 'endpoint', status: 'UPDATING' },
  ])('says where to look after a harness that is $kind ($what)', (state) => {
    expect(harnessReport([{ agentName: 'FinOps', state }])).toEqual({
      line: 'AgentCore no tiene listo el harness de alguno',
      failure: [harnessProblem('FinOps', state), HARNESS_WHERE_TO_LOOK],
    });
  });

  it('does not say where to look when all it could not do is ask', () => {
    const asked = ['FinOps', 'Soporte'].map((agentName) => ({ agentName, state: unknown }));
    expect(harnessReport(asked)).toEqual({
      line: 'no se pudo preguntar a AgentCore por su harness',
      failure: [harnessProblem('FinOps', unknown), harnessProblem('Soporte', unknown)],
    });
  });

  it('says where to look, once and last, when one is missing and another could not be asked', () => {
    const report = harnessReport([
      { agentName: 'FinOps', state: unknown },
      { agentName: 'Soporte', state: missing },
      { agentName: 'Ventas', state: { kind: 'ready' } },
      { agentName: 'Legal', state: { kind: 'not-ready', what: 'harness', status: 'DELETING' } },
    ]);
    expect(report).toEqual({
      line: 'no se pudo preguntar a AgentCore por su harness',
      failure: [
        harnessProblem('FinOps', unknown),
        harnessProblem('Soporte', missing),
        harnessProblem('Legal', { kind: 'not-ready', what: 'harness', status: 'DELETING' }),
        HARNESS_WHERE_TO_LOOK,
      ],
    });
  });

  it('says nothing of agents it did not ask about', () => {
    expect(harnessReport([]).failure).toEqual([]);
  });
});
