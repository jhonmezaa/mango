import { z } from 'zod';

import {
  isActive,
  judge,
  releaseAgents,
  reportLine,
  WHERE_TO_LOOK,
  type Evidence,
} from '../src/agents.ts';
import { ROLES } from '../src/config.ts';
import { expect, note, test, type Session } from '../src/fixtures.ts';
import {
  harnessName,
  harnessOf,
  harnessReport,
  listHarnesses,
  type Asked,
} from '../src/harness.ts';

// The agents the release ships are published and the installation serves them. A release
// publishes its agents while it installs, so an installation without them is broken even if
// every screen works: with no agent at all, the Marketplace and the API agree on an empty
// list. Reads only: no turn of chat, no change. Leaves the read events in Auditoría.
//
// The application serves an agent from its own records and never asks AgentCore, so with
// `aws.namespace` in the configuration the journey asks AgentCore itself (two reads with the
// AWS CLI) whether the harness of each served agent is there (D75 (10)).

const agents = z.looseObject({
  items: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      retired_at: z.string().nullable(),
    }),
  ),
});
const detail = z.looseObject({
  status: z.string(),
  unavailable_tools: z.array(z.string()).default([]),
});
const org = z.looseObject({ nodes: z.array(z.looseObject({ id: z.string() })) });
const reviews = z.looseObject({
  history: z.array(
    z.looseObject({
      agent_id: z.string(),
      status: z.string(),
      failed_step: z.string().nullable(),
      retryable: z.boolean(),
    }),
  ),
});

async function read(session: Session, path: string): Promise<unknown> {
  const answer = await session.api('GET', path);
  expect(answer.status, `GET ${path} as ${session.role}`).toBe(200);
  return answer.body;
}

/** `GET /api/agents/<id>`: the version the chat would serve to this person. */
async function served(session: Session, id: string): Promise<NonNullable<Evidence['served']>> {
  const answer = await session.api('GET', `/api/agents/${encodeURIComponent(id)}`);
  const body = detail.safeParse(answer.body);
  return {
    role: session.role,
    status: answer.status,
    code: answer.code,
    agentStatus: body.success ? body.data.status : null,
    unavailableTools: body.success ? body.data.unavailable_tools.length : 0,
  };
}

test('the agents of the release are published and served', async ({ as, config }, testInfo) => {
  const roles = ROLES.filter((role) => config.users[role]);
  test.skip(roles.length === 0, 'no hay ningún usuario configurado');

  const people: { session: Session; items: z.infer<typeof agents>['items'] }[] = [];
  for (const role of roles) {
    const session = await as(role);
    people.push({ session, items: agents.parse(await read(session, '/api/agents')).items });
  }
  const admin = people.find(({ session }) => session.me.is_admin)?.session;
  const tree = admin ? org.parse(await read(admin, '/api/agents/org')).nodes : [];
  const history = admin ? reviews.parse(await read(admin, '/api/agents/reviews')).history : [];

  const broken: string[] = [];
  const lines: string[] = [];
  const proven = new Set<string>();
  for (const agent of releaseAgents()) {
    const listed = people.map(({ session, items }) => ({
      role: session.role,
      item: items.find((item) => item.id === agent.id),
    }));
    const user = people.find(({ items }) =>
      items.some((item) => item.id === agent.id && isActive(item)),
    );
    const evidence: Evidence = {
      listed,
      served: user ? await served(user.session, agent.id) : undefined,
      admin: admin
        ? {
            inTree: tree.some((node) => node.id === agent.id),
            // Newest first: the first row of the agent is the last decision on it.
            review: history.find((row) => row.agent_id === agent.id),
          }
        : undefined,
    };
    const verdict = judge(agent, evidence);
    lines.push(reportLine(agent, verdict));
    if (verdict.kind === 'broken') broken.push(verdict.why);
    if (verdict.kind === 'served') proven.add(agent.id);
  }

  // What the application cannot tell: whether AgentCore still has the harness of each agent
  // it serves. Asked once for the whole account and once per agent, with the AWS CLI.
  let unreachable: string[] = [];
  const namespace = config.aws?.namespace;
  const servedAgents = releaseAgents().filter((agent) => proven.has(agent.id));
  const anyone = people[0]?.session;
  if (namespace && anyone && servedAgents.length > 0) {
    const { region } = z
      .looseObject({ region: z.string().regex(/^[a-z0-9-]{1,32}$/) })
      .parse(await (await anyone.context.request.get('/config.json')).json());
    const account = { profile: config.aws?.profile, region };
    const listed = await listHarnesses(account);
    const asked: Asked[] = [];
    for (const agent of servedAgents) {
      const state =
        listed instanceof Map
          ? await harnessOf(account, listed, harnessName(namespace, agent.id))
          : ({ kind: 'unknown', code: listed.code } as const);
      asked.push({ agentName: agent.name, state });
    }
    const report = harnessReport(asked);
    lines.push(report.line);
    unreachable = report.failure;
  } else if (servedAgents.length > 0) {
    lines.push('no se preguntó a AgentCore por su harness (falta `aws.namespace`)');
  }

  // The agent the journey with effect `chat` would ask, for the person who would ask.
  const chat = config.chat;
  const asker = chat ? people.find(({ session }) => session.role === chat.role) : undefined;
  if (chat && asker) {
    const item = asker.items.find((candidate) => candidate.name === chat.agent);
    if (!item || !isActive(item)) {
      broken.push(
        `The agent of \`chat.agent\` is not in the Marketplace of «${chat.role}»: the journey ` +
          'with effect `chat` would have nobody to ask.',
      );
    } else if (!proven.has(item.id)) {
      const answer = await served(asker.session, item.id);
      if (answer.status === 200 && answer.agentStatus === 'published') proven.add(item.id);
      else {
        broken.push(
          `The agent of \`chat.agent\` is in the Marketplace of «${chat.role}», but its detail ` +
            `answered ${answer.status}${answer.code ? ` ${answer.code}` : ''}: the chat would ` +
            'not serve it.',
        );
      }
    }
  }

  // An installation nobody can ask anything is broken, whatever the release ships.
  const active = new Set(
    people.flatMap(({ items }) => items.filter(isActive).map((item) => item.id)),
  );
  if (active.size === 0) {
    broken.unshift('No test user has an active agent in the Marketplace.');
  }

  note(testInfo, `agents: ${lines.join('; ') || 'la versión no trae agentes'}`);
  if (broken.length > 0 || unreachable.length > 0) {
    throw new Error(
      [...broken, ...(broken.length > 0 ? [WHERE_TO_LOOK] : []), ...unreachable].join('\n'),
    );
  }
});
