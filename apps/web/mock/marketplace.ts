/**
 * Mock routes of the Marketplace screen: GET /agents, GET /agents/mine and POST /agents/{id}/retire.
 * The agents live in `agents.ts`; the responses follow the generated contract
 * (packages/ts/api-client).
 */
import { agentOut, agents, versionOf, type MockAgent, type MockAgentVersion } from './agents.ts';
import { MOCK_USER } from './cognito.ts';
import { readObject, sendError, sendJson, type ApiHandler } from './http.ts';

/** Mango groups of the mock user (the ones `GET /me` answers). */
const MOCK_USER_GROUPS: readonly string[] = ['finops-central', 'mango-admin'];
const OPEN_STATUSES: readonly string[] = ['draft', 'in_review', 'approved', 'failed'];
const MAX_DRAFTS = 20;
const MAX_SUBMISSIONS_PER_DAY = 5;
const MAX_REASON = 500;

/** The published or retired version, when the mock user is in its access lists (`UseAgent`). */
function usableVersion(agent: MockAgent): MockAgentVersion | null {
  if (agent.status === 'draft') return null;
  const version = versionOf(agent, agent.published_version);
  if (!version) return null;
  const { groups, users } = version.definition;
  const shared = users.includes(MOCK_USER) || groups.some((id) => MOCK_USER_GROUPS.includes(id));
  return shared ? version : null;
}

function listAgents() {
  const items = [...agents.values()].flatMap((agent) => {
    const version = usableVersion(agent);
    // `lock_version` only comes in the detail (GET /agents/{id}).
    return version ? [{ ...agentOut(agent, version), lock_version: null }] : [];
  });
  return { items: items.sort((a, b) => a.name.localeCompare(b.name, 'es')) };
}

function listMine() {
  const items = [...agents.values()].flatMap((agent) => {
    const version = versionOf(agent, agent.open_version);
    if (!version || version.created_by !== MOCK_USER || !OPEN_STATUSES.includes(version.status)) {
      return [];
    }
    const { definition } = version;
    return [
      {
        agent_id: agent.agent_id,
        version: version.number,
        status: version.status,
        revision: version.revision,
        base_version: version.base_version,
        name: definition.name,
        description: definition.description,
        category: definition.category,
        icon: definition.icon,
        color: definition.color,
        created_at: version.created_at,
        updated_at: version.updated_at,
        submitted_at: version.submitted_at,
        rejected_at: version.rejected_at,
        rejection_reason: version.rejection_reason,
        failed_step: version.failed_step,
      },
    ];
  });
  const dayStart = new Date().toISOString().slice(0, 10);
  return {
    items: items.sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    quotas: {
      drafts: items.filter((item) => item.status === 'draft').length,
      max_drafts: MAX_DRAFTS,
      submissions_today: items.filter((item) => item.submitted_at?.startsWith(dayStart)).length,
      max_submissions_per_day: MAX_SUBMISSIONS_PER_DAY,
    },
  };
}

export const handleMarketplace: ApiHandler = async (req, res, path) => {
  if (path === '/agents' && req.method === 'GET') {
    sendJson(res, 200, listAgents());
    return true;
  }
  if (path === '/agents/mine' && req.method === 'GET') {
    sendJson(res, 200, listMine());
    return true;
  }
  const retire = /^\/agents\/([a-z0-9-]{1,64})\/retire$/.exec(path);
  if (retire && req.method === 'POST') {
    const body = await readObject(req, ['lock_version', 'reason']);
    const reason = typeof body?.reason === 'string' ? body.reason : '';
    if (
      !body ||
      !Number.isInteger(body.lock_version) ||
      reason.length < 1 ||
      reason.length > MAX_REASON
    ) {
      sendError(res, 422, 'invalid_request', 'Invalid retire request');
      return true;
    }
    // The mock user is an admin: a missing agent is a 404 for them.
    const agent = agents.get(retire[1] ?? '');
    const version = agent ? versionOf(agent, agent.published_version) : null;
    if (!agent || !version) {
      sendError(res, 404, 'not_found', 'Agent not found');
      return true;
    }
    if (agent.status !== 'published' || agent.lock_version !== body.lock_version) {
      sendError(res, 409, 'version_conflict', 'The agent changed or is not published');
      return true;
    }
    agent.status = 'retired';
    agent.lock_version += 1;
    agent.retired_by = MOCK_USER;
    agent.retired_at = new Date().toISOString();
    agent.retire_reason = reason;
    version.status = 'retired';
    sendJson(res, 200, agentOut(agent, version));
    return true;
  }
  return false;
};
