import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { REPO_ROOT } from './config.ts';

// The agents a release ships, and what a read-only run can tell about each one in an
// installation: published and served, retired by somebody, or broken. Nothing here asks the
// installation anything: the journey gathers the answers and `judge` reads them.

export interface ReleaseAgent {
  /** The slug the release reserves for it (`agents/<id>/agent.json`). */
  id: string;
  name: string;
}

const agentFile = z.looseObject({
  id: z.string().min(1),
  definition: z.looseObject({ name: z.string().min(1) }),
});

/**
 * The agents of the release this repository is at: one per `agents/<id>/agent.json`. Every
 * release publishes them while it installs, so the installed tag must be checked out.
 */
export function releaseAgents(repoRoot = REPO_ROOT): ReleaseAgent[] {
  const dir = join(repoRoot, 'agents');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(dir, entry.name, 'agent.json'), 'utf8'));
      } catch {
        throw new Error(`agents/${entry.name}/agent.json cannot be read or is not JSON.`);
      }
      const parsed = agentFile.safeParse(raw);
      if (!parsed.success || parsed.data.id !== entry.name) {
        throw new Error(`agents/${entry.name}/agent.json does not declare that agent.`);
      }
      return { id: parsed.data.id, name: parsed.data.definition.name };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** An agent as `GET /api/agents` lists it for one person. */
export interface Listed {
  status: string;
  retired_at: string | null;
}

export const isActive = (item: Listed): boolean =>
  item.status === 'published' && item.retired_at === null;

export interface Evidence {
  /** The Marketplace of each test user: the agent as listed there, or `undefined`. */
  listed: readonly { role: string; item: Listed | undefined }[];
  /**
   * `GET /api/agents/<id>` as the first person whose Marketplace has it active. That route
   * answers with the version the chat would serve (the pointer of the provisioner, its hash
   * and its harness), so a 200 is the nearest a read gets to a turn.
   */
  served:
    | {
        role: string;
        status: number;
        code: string | null;
        agentStatus: string | null;
        unavailableTools: number;
      }
    | undefined;
  /** What an administrator sees, when the run has one: the whole tree and the publications. */
  admin:
    | {
        inTree: boolean;
        /** The newest decision on a version of the agent, from the review history. */
        review: { status: string; failed_step: string | null; retryable: boolean } | undefined;
      }
    | undefined;
}

export type Verdict =
  | { kind: 'served'; by: string; unavailableTools: number; failedUpdate: string | null }
  | { kind: 'retired' }
  | { kind: 'broken'; why: string };

/** Where whoever installs looks when an agent of the release is not published. */
export const WHERE_TO_LOOK =
  'What to look at: the alarm `Mango-<ns>-AgentProvisioner-failed`, the last execution of the ' +
  'agent provisioner (the state machine of the output `AgentProvisionerArn` of ' +
  '`Mango-<ns>-Core`), its log `/aws/lambda/Mango-<ns>-Provisioner`, and «Problemas conocidos» ' +
  'in docs/runbooks/install.md. An administrator retries a failed publication from the ' +
  'application («Reintentar» in the reviews of the Agent Builder).';

const step = (failed: string | null): string => (failed ? ` at the step \`${failed}\`` : '');

export function judge(agent: ReleaseAgent, evidence: Evidence): Verdict {
  const { served, admin } = evidence;
  const review = admin?.review;
  if (evidence.listed.some(({ item }) => item && isActive(item))) {
    if (served?.status === 200 && served.agentStatus === 'published') {
      return {
        kind: 'served',
        by: served.role,
        unavailableTools: served.unavailableTools,
        // An update whose publication failed leaves the version before it serving.
        failedUpdate: review?.status === 'failed' ? (review.failed_step ?? 'unknown') : null,
      };
    }
    const answer = served
      ? `${served.status}${served.code ? ` ${served.code}` : ''}`
      : 'nothing the check could read';
    return {
      kind: 'broken',
      why:
        `«${agent.name}» is in the Marketplace of «${served?.role ?? '?'}», but ` +
        `GET /api/agents/${agent.id} answered ${answer}: the chat would not serve it ` +
        '(the published pointer, its content or its harness do not hold).',
    };
  }
  const retired = evidence.listed.some(({ item }) => item && !isActive(item));
  if (retired || review?.status === 'retired') return { kind: 'retired' };
  if (review?.status === 'failed') {
    return {
      kind: 'broken',
      why: `«${agent.name}» is not published: its publication failed${step(review.failed_step)}.`,
    };
  }
  if (review?.status === 'approved') {
    return {
      kind: 'broken',
      why:
        `«${agent.name}» is not published: it was seeded, and the provisioner ` +
        (review.retryable ? 'is no longer publishing it.' : 'has not finished publishing it.'),
    };
  }
  if (admin?.inTree) {
    return {
      kind: 'broken',
      why:
        `«${agent.name}» is published, but no test user of the configuration can use it, so ` +
        'the check cannot tell whether it is served: give one test user a group of the agent.',
    };
  }
  if (admin) {
    return {
      kind: 'broken',
      why:
        `«${agent.name}» is not published, and the review history does not name it: the ` +
        'release did not seed it, or its publication never started.',
    };
  }
  return {
    kind: 'broken',
    why:
      `«${agent.name}» is in the Marketplace of no test user. Without a user for the role ` +
      '«admin» the check cannot tell whether it was published.',
  };
}

/** The line of the report for one agent (Spanish, like the report). */
export function reportLine(agent: ReleaseAgent, verdict: Verdict): string {
  if (verdict.kind === 'retired')
    return `«${agent.name}» retirado en la instalación, no se comprueba`;
  if (verdict.kind === 'broken') return `«${agent.name}» no está publicado y servido`;
  const tools =
    verdict.unavailableTools > 0
      ? `; ${verdict.unavailableTools} de sus tools no están disponibles (su pack no está instalado)`
      : '';
  const update = verdict.failedUpdate
    ? `; su última publicación falló en el paso «${verdict.failedUpdate}» y se sirve la versión anterior`
    : '';
  return `«${agent.name}» publicado y servido (visto como «${verdict.by}»)${tools}${update}`;
}
