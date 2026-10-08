import { z } from 'zod';

import { aws, type Account } from './aws.ts';

// Whether the harness of a published agent exists in AgentCore. The application does not ask:
// it serves an agent from its own records (the pointer of the provisioner, its hash, the shape
// of the harness ARN), so a harness deleted outside Mango, or by an uninstall that stopped
// halfway, leaves an agent that is «published and served» and cannot answer. Two reads with
// the AWS CLI; nothing is changed, invoked or echoed.

export const LIVE_ENDPOINT = 'live';
const READY = 'READY';

/** The name the provisioner gives the harness of an agent (`agentNames` in `infra/lib/names.ts`). */
export const harnessName = (namespace: string, agentId: string): string =>
  `Mango_${namespace}_a_${agentId}`;

export type HarnessState =
  | { kind: 'ready' }
  /** AgentCore has no harness of that name, or it has no `live` endpoint. */
  | { kind: 'missing'; what: 'harness' | 'endpoint' }
  | { kind: 'not-ready'; what: 'harness' | 'endpoint'; status: string }
  /** AgentCore could not be asked: no credentials, no permission, a CLI without the command. */
  | { kind: 'unknown'; code: string };

const harnesses = z.looseObject({
  harnesses: z.array(
    z.looseObject({ harnessId: z.string(), harnessName: z.string(), status: z.string() }),
  ),
});
const endpoint = z.looseObject({ endpoint: z.looseObject({ status: z.string() }) });

/** The error code the CLI names (`An error occurred (<code>) when calling…`), and only that. */
export function errorCode(error: unknown): string {
  const stderr =
    typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
  const named = /An error occurred \(([A-Za-z]{1,64})\)/.exec(stderr)?.[1];
  if (named) return named;
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
    return 'NoAwsCli';
  return 'CommandFailed';
}

type Cli = (account: Account, args: string[]) => Promise<string>;

/** Every harness of the account and region by name. One listing serves every agent. */
export async function listHarnesses(
  account: Account,
  cli: Cli = aws,
): Promise<Map<string, { id: string; status: string }> | { code: string }> {
  try {
    const listed = harnesses.parse(
      JSON.parse(await cli(account, ['bedrock-agentcore-control', 'list-harnesses'])),
    );
    return new Map(
      listed.harnesses.map((one) => [one.harnessName, { id: one.harnessId, status: one.status }]),
    );
  } catch (error) {
    return {
      code:
        error instanceof SyntaxError || error instanceof z.ZodError
          ? 'UnreadableAnswer'
          : errorCode(error),
    };
  }
}

/** The state of the harness of one agent and of the endpoint the chat invokes. */
export async function harnessOf(
  account: Account,
  listed: Map<string, { id: string; status: string }>,
  name: string,
  cli: Cli = aws,
): Promise<HarnessState> {
  const harness = listed.get(name);
  if (!harness) return { kind: 'missing', what: 'harness' };
  if (harness.status !== READY)
    return { kind: 'not-ready', what: 'harness', status: harness.status };
  try {
    const answer = endpoint.parse(
      JSON.parse(
        await cli(account, [
          'bedrock-agentcore-control',
          'get-harness-endpoint',
          '--harness-id',
          harness.id,
          '--endpoint-name',
          LIVE_ENDPOINT,
        ]),
      ),
    );
    const { status } = answer.endpoint;
    return status === READY ? { kind: 'ready' } : { kind: 'not-ready', what: 'endpoint', status };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return { kind: 'unknown', code: 'UnreadableAnswer' };
    const code = errorCode(error);
    return code === 'ResourceNotFoundException'
      ? { kind: 'missing', what: 'endpoint' }
      : { kind: 'unknown', code };
  }
}

/** Where whoever installs looks when the harness of a published agent is not there. */
export const HARNESS_WHERE_TO_LOOK =
  'What to look at: whether an uninstall stopped halfway (the stack `Mango-<ns>-Core` in ' +
  '`DELETE_FAILED`, step 5 of docs/runbooks/install.md), the finding `harness_missing` of the ' +
  'daily reconciliation (the alarm `Mango-<ns>-Reconciler-findings`) and who deleted it ' +
  '(CloudTrail, `DeleteHarness`). Publishing a new version of the agent creates its harness ' +
  'again.';

/** Why an agent the application serves cannot answer, or `null` when its harness is ready. */
export function harnessProblem(agentName: string, state: HarnessState): string | null {
  switch (state.kind) {
    case 'ready':
      return null;
    case 'missing':
      return (
        `«${agentName}» is published and the application serves it, but AgentCore has no ` +
        `${state.what === 'harness' ? 'harness' : `\`${LIVE_ENDPOINT}\` endpoint`} for it: ` +
        'nobody can get an answer from it.'
      );
    case 'not-ready':
      return (
        `«${agentName}» is published and the application serves it, but its ` +
        `${state.what === 'harness' ? 'harness' : `\`${LIVE_ENDPOINT}\` endpoint`} is ` +
        `${state.status} in AgentCore, not ${READY}.`
      );
    case 'unknown':
      return (
        `The check could not ask AgentCore for the harness of «${agentName}» (${state.code}). ` +
        'With `aws.namespace` in the configuration the check asks: renew the credentials of ' +
        'the profile, give it `bedrock-agentcore:ListHarnesses` and ' +
        '`bedrock-agentcore:GetHarnessEndpoint`, or remove `aws.namespace` to skip the question.'
      );
  }
}
