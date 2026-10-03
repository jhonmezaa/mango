import type { IncomingMessage, ServerResponse } from 'node:http';

import { zGetOrgResponse } from '@mango/api-client/schemas';
import { describe, expect, it } from 'vitest';

import { agents, publishedVersion, ROOT_SUPERVISOR } from './agents.ts';
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

  it('leaves every other route to the next handler', async () => {
    expect((await call('POST', '/agents/org')).handled).toBe(false);
    expect((await call('GET', '/agents/finops')).handled).toBe(false);
  });
});
