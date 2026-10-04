import type { IncomingMessage, ServerResponse } from 'node:http';

import { zGetOrgResponse } from '@mango/api-client/schemas';
import { describe, expect, it } from 'vitest';

import { agents, publishedVersion, ROOT_SUPERVISOR, type MockAgent } from './agents.ts';
import { MOCK_USER } from './cognito.ts';
import { MOCK_USER_GROUPS } from './marketplace.ts';
import { handleOrgChart } from './orgChart.ts';

async function call(method: string, path: string) {
  const sent = { handled: false, status: 0, body: '' };
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end(body?: string) {
      sent.status = this.statusCode;
      sent.body = body ?? '';
    },
  };
  sent.handled = await handleOrgChart(
    { method } as IncomingMessage,
    res as unknown as ServerResponse,
    path,
    new URL(`http://localhost${path}`),
  );
  return sent;
}

describe('mock org chart', () => {
  it('serves the published agents as GET /agents/org of the contract', async () => {
    const sent = await call('GET', '/agents/org');
    expect(sent).toMatchObject({ handled: true, status: 200 });
    const org = zGetOrgResponse.parse(JSON.parse(sent.body));
    expect(org.root).toBe(ROOT_SUPERVISOR);

    const published = [...agents.values()].filter((agent) => publishedVersion(agent));
    expect(org.nodes.map((node) => node.id).sort()).toEqual(
      published.map((agent) => agent.agent_id).sort(),
    );
    // Drafts, versions in review and retired agents are not part of the chart.
    for (const node of org.nodes) expect(agents.get(node.id)?.status).toBe('published');
    // Every supervisor is the root or another node of the answer.
    const ids = new Set(org.nodes.map((node) => node.id));
    for (const node of org.nodes) {
      expect(node.reports_to === ROOT_SUPERVISOR || ids.has(node.reports_to ?? '')).toBe(true);
    }
    expect(org.nodes.find((node) => node.id === 'finops')).toMatchObject({
      name: 'FinOps',
      role: 'Analista FinOps',
      reports_to: ROOT_SUPERVISOR,
    });
  });

  it('says which agents the mock user cannot use, and who uses them', async () => {
    const org = zGetOrgResponse.parse(JSON.parse((await call('GET', '/agents/org')).body));
    for (const node of org.nodes) {
      const definition = publishedVersion(agents.get(node.id) as MockAgent)?.definition;
      const mine = definition?.groups.some((group) => MOCK_USER_GROUPS.includes(group)) ?? false;
      expect(node.can_use).toBe(mine || (definition?.users.includes(MOCK_USER) ?? false));
      // The groups only come with an agent that cannot be used.
      expect(node.groups).toEqual(node.can_use ? [] : definition?.groups.toSorted());
    }
  });

  it('leaves every other route to the next handler', async () => {
    expect((await call('POST', '/agents/org')).handled).toBe(false);
    expect((await call('GET', '/agents/finops')).handled).toBe(false);
  });
});
