/**
 * Mock routes of the Brains screen: GET /admin/models, PUT /admin/models/{id} and
 * POST /admin/models/refresh. In-memory state in the generated contract
 * (packages/ts/api-client); the agents that use each model come from `agents.ts`. It includes
 * a string with HTML to check it renders as text.
 */
import { MOCK_MODEL, agents, publishedVersion } from './agents.ts';
import { auditedWrite } from './audit.ts';
import { MOCK_USER } from './cognito.ts';
import { readBody, readObject, sendError, sendJson, type ApiHandler } from './http.ts';

const PRICE_PATTERN = /^\d{1,6}(\.\d{1,4})?$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,127}$/;
const REASON_MAX_LENGTH = 500;
const HOUR_MS = 3_600_000;

interface MockModel {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  supports_tools: boolean;
  supports_vision: boolean;
  /** null: the release capabilities do not know the context size. */
  context_tokens: number | null;
  /** null: nobody gave the model a price yet. */
  input_usd: string | null;
  output_usd: string | null;
  list_input_usd: string | null;
  list_output_usd: string | null;
  in_bedrock: boolean | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  disabled_by: string | null;
  disabled_at: string | null;
  disabled_reason: string | null;
}

function model(overrides: Partial<MockModel> & Pick<MockModel, 'id' | 'name'>): MockModel {
  return {
    provider: 'Anthropic',
    enabled: false,
    supports_tools: true,
    supports_vision: true,
    context_tokens: 200_000,
    input_usd: null,
    output_usd: null,
    list_input_usd: null,
    list_output_usd: null,
    in_bedrock: true,
    confirmed_by: null,
    confirmed_at: null,
    disabled_by: null,
    disabled_at: null,
    disabled_reason: null,
    ...overrides,
  };
}

const catalog = {
  version: 4,
  refreshed_at: new Date(Date.now() - 0.7 * HOUR_MS).toISOString() as string | null,
  models: [
    model({
      id: MOCK_MODEL,
      name: 'US Claude Sonnet 4.6',
      enabled: true,
      input_usd: '3',
      output_usd: '15',
      list_input_usd: '3',
      list_output_usd: '15',
    }),
    model({
      id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      name: 'US Claude Haiku 4.5',
      input_usd: '1',
      output_usd: '5',
      list_input_usd: '1',
      list_output_usd: '5',
    }),
    model({
      id: 'us.anthropic.claude-opus-4-7',
      name: 'US Claude Opus 4.7',
      input_usd: '4.5',
      output_usd: '22.5',
      confirmed_by: 'otra.admin@example.com',
      confirmed_at: new Date(Date.now() - 300 * HOUR_MS).toISOString(),
      disabled_by: 'otra.admin@example.com',
      disabled_at: new Date(Date.now() - 50 * HOUR_MS).toISOString(),
      disabled_reason: 'Costo alto <img src=x onerror=alert(1)>',
    }),
    model({
      id: 'us.amazon.nova-pro-v1:0',
      name: 'US Nova Pro',
      provider: 'Amazon',
      supports_tools: false,
    }),
    model({
      id: 'us.meta.llama4-maverick-17b-instruct-v1:0',
      name: 'US Llama 4 Maverick 17B Instruct',
      provider: 'Meta',
      supports_tools: false,
      supports_vision: false,
      in_bedrock: false,
    }),
  ],
};

/** What "Actualizar catálogo" finds the first time. */
const discoverable = [
  model({
    id: 'us.mistral.pixtral-large-2502-v1:0',
    name: 'US Pixtral Large 25.02',
    provider: 'Mistral AI',
    supports_tools: false,
  }),
];

function statusOf(item: MockModel): 'enabled' | 'available' | 'disabled' | 'noaccess' {
  if (item.in_bedrock === false) return 'noaccess';
  if (item.enabled) return 'enabled';
  return item.disabled_by !== null ? 'disabled' : 'available';
}

function agentsUsing(modelId: string) {
  return [...agents.values()]
    .flatMap((agent) => {
      const version = publishedVersion(agent);
      if (!version) return [];
      const { definition } = version;
      const models = new Set([...definition.allowed_models, definition.model]);
      return models.has(modelId)
        ? [{ id: agent.agent_id, name: definition.name, category: definition.category }]
        : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const cachePrice = (inputUsd: string, ratio: number) =>
  String(Math.round(Number(inputUsd) * ratio * 1e6) / 1e6);

function view() {
  return {
    version: catalog.version,
    region: 'us-east-1',
    refreshed_at: catalog.refreshed_at,
    items: catalog.models.map((item) => ({
      id: item.id,
      name: item.name,
      provider: item.provider,
      status: statusOf(item),
      is_default: item.id === MOCK_MODEL,
      supports_tools: item.supports_tools,
      supports_vision: item.supports_vision,
      context_tokens: item.supports_tools ? item.context_tokens : null,
      input_usd: item.input_usd,
      output_usd: item.output_usd,
      // Same ratios as the release prices of the mock: 10 % to read, 125 % to write.
      cache_read_usd: item.input_usd === null ? null : cachePrice(item.input_usd, 0.1),
      cache_write_usd: item.input_usd === null ? null : cachePrice(item.input_usd, 1.25),
      list_input_usd: item.list_input_usd,
      list_output_usd: item.list_output_usd,
      confirmed_by: item.confirmed_by,
      confirmed_at: item.confirmed_at,
      disabled_by: item.disabled_by,
      disabled_at: item.disabled_at,
      disabled_reason: item.disabled_reason,
      agents: agentsUsing(item.id),
    })),
  };
}

function isPrice(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    PRICE_PATTERN.test(value) &&
    Number(value) > 0 &&
    Number(value) <= 100_000
  );
}

const trimPrice = (value: string) => String(Number(value));

export const handleBrains: ApiHandler = async (req, res, path) => {
  if (path === '/admin/models' && req.method === 'GET') {
    sendJson(res, 200, view());
    return true;
  }
  if (path === '/admin/models/refresh' && req.method === 'POST') {
    if ((await readObject(req, [])) === null) {
      sendError(res, 422, 'invalid_request', 'invalid fields: ?');
      return true;
    }
    const added = discoverable.splice(0);
    auditedWrite(
      'settings.models.refreshed',
      {
        base_version: catalog.version,
        added: added.map((item) => item.id),
        added_count: added.length,
        missing: catalog.models.filter((item) => item.in_bedrock === false).map((item) => item.id),
        missing_count: catalog.models.filter((item) => item.in_bedrock === false).length,
      },
      () => {
        catalog.models.push(...added);
        catalog.refreshed_at = new Date().toISOString();
        catalog.version += 1;
      },
    );
    sendJson(res, 200, view());
    return true;
  }
  const match = /^\/admin\/models\/([^/]+)$/.exec(path);
  if (!match || req.method !== 'PUT') return false;
  const modelId = decodeURIComponent(match[1] ?? '');
  if (!MODEL_ID_PATTERN.test(modelId)) {
    sendError(res, 422, 'invalid_request', 'invalid fields: model_id');
    return true;
  }
  const item = catalog.models.find((candidate) => candidate.id === modelId);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
  } catch {
    body = {};
  }
  const allowed = new Set(['version', 'enabled', 'input_usd', 'output_usd', 'reason']);
  const { version, enabled } = body;
  const inputUsd = body.input_usd ?? null;
  const outputUsd = body.output_usd ?? null;
  const reason = body.reason ?? null;
  const valid =
    Object.keys(body).every((key) => allowed.has(key)) &&
    Number.isInteger(version) &&
    typeof enabled === 'boolean' &&
    (enabled
      ? isPrice(inputUsd) && isPrice(outputUsd) && reason === null
      : inputUsd === null &&
        outputUsd === null &&
        (reason === null || (typeof reason === 'string' && reason.length <= REASON_MAX_LENGTH)));
  if (!valid) {
    sendError(res, 422, 'invalid_request', 'invalid fields: ?');
    return true;
  }
  if (!item) {
    sendError(res, 404, 'not_found', 'not found');
    return true;
  }
  if (version !== catalog.version) {
    sendError(res, 409, 'version_conflict', 'catalog changed; reload and retry');
    return true;
  }
  const now = new Date().toISOString();
  if (enabled) {
    if (item.in_bedrock === false) {
      sendError(res, 409, 'model_no_access', 'the account has no access to this model');
      return true;
    }
    const after = {
      input_usd: trimPrice(inputUsd as string),
      output_usd: trimPrice(outputUsd as string),
    };
    auditedWrite(
      item.enabled ? 'settings.model.price_updated' : 'settings.model.enabled',
      {
        model: modelId,
        base_version: catalog.version,
        before: { input_usd: item.input_usd ?? '0', output_usd: item.output_usd ?? '0' },
        after,
      },
      () => {
        Object.assign(item, after, {
          enabled: true,
          confirmed_by: MOCK_USER,
          confirmed_at: now,
          disabled_by: null,
          disabled_at: null,
          disabled_reason: null,
        });
        catalog.version += 1;
      },
    );
  } else {
    if (!item.enabled) {
      sendError(res, 409, 'model_not_enabled', 'the model is not enabled');
      return true;
    }
    if (modelId === MOCK_MODEL) {
      sendError(res, 409, 'default_model', 'the default model cannot be disabled');
      return true;
    }
    const affected = agentsUsing(modelId);
    const why = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
    auditedWrite(
      'settings.model.disabled',
      {
        model: modelId,
        base_version: catalog.version,
        reason: why,
        affected_agents: affected.map((agent) => agent.id),
        affected_agent_count: affected.length,
      },
      () => {
        Object.assign(item, {
          enabled: false,
          disabled_by: MOCK_USER,
          disabled_at: now,
          disabled_reason: why,
        });
        catalog.version += 1;
      },
    );
  }
  sendJson(res, 200, view());
  return true;
};
