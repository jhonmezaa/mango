/**
 * Mock routes of the Org Chart screen: GET /agents/org.
 * The agents live in `agents.ts`; the response follows the generated contract
 * (packages/ts/api-client) and `organization` of mango_api.agents. The mock user is an admin, so
 * they get every published agent (D38); the ones shared with groups they are not in come with
 * `can_use: false` and those groups (D65).
 */
import { agents, publishedVersion, ROOT_SUPERVISOR } from './agents.ts';
import { MOCK_USER } from './cognito.ts';
import { sendJson, type ApiHandler } from './http.ts';
import { MOCK_USER_GROUPS } from './marketplace.ts';

export const handleOrgChart: ApiHandler = (req, res, path) => {
  if (path !== '/agents/org' || req.method !== 'GET') return Promise.resolve(false);
  const published = [...agents.values()].flatMap((agent) => {
    const version = publishedVersion(agent);
    return version
      ? [{ id: agent.agent_id, version: version.number, definition: version.definition }]
      : [];
  });
  const visible = new Set(published.map((agent) => agent.id));
  const nodes = published
    .map(({ id, version, definition }) => {
      const supervisor = definition.reports_to ?? ROOT_SUPERVISOR;
      const canUse =
        definition.users.includes(MOCK_USER) ||
        definition.groups.some((group) => MOCK_USER_GROUPS.includes(group));
      return {
        id,
        version,
        name: definition.name,
        role: definition.role,
        description: definition.description,
        category: definition.category,
        icon: definition.icon,
        color: definition.color,
        // null when the supervisor is retired or not published.
        reports_to: supervisor === ROOT_SUPERVISOR || visible.has(supervisor) ? supervisor : null,
        can_use: canUse,
        groups: canUse ? [] : definition.groups.toSorted(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id));
  sendJson(res, 200, { root: ROOT_SUPERVISOR, nodes });
  return Promise.resolve(true);
};
