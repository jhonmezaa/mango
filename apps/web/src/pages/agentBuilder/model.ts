import { isRuleCode, type RuleCode } from '../../agents/rules';
import { ApiError } from '../../api/errors';
import type { OperationInput, OperationOutput } from '../../api/operations';
import type { agentBuilder } from '../../i18n/locales/es/agentBuilder';

// Data and rules of the Agent Builder (design admin.jsx and lifecycle.js). The checks here only
// guide the creator: what counts is validated by the API when the version is sent (plan A8).

export type Version = OperationOutput<'readVersion'>;
export type Definition = Version['definition'];
export type DefinitionInput = OperationInput<'postAgent'>['body']['definition'];
export type Connector = OperationOutput<'getCatalog'>['items'][number];
export type Model = OperationOutput<'getModels'>['items'][number];
export type Group = OperationOutput<'listGroups'>['items'][number];
export type OrgNode = OperationOutput<'getOrg'>['nodes'][number];
export type Quotas = OperationOutput<'getMine'>['quotas'];
export type Violation = NonNullable<Version['violations']>[number];

export const SECTION_IDS = ['identity', 'org', 'brain', 'tools', 'limits', 'access'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/** Root of the organization chart (`mango_core.agents.ROOT_SUPERVISOR`). */
export const ROOT_SUPERVISOR = 'platform';

export const NAME_MAX = 40;
export const DESCRIPTION_MAX = 140;
export const ROLE_MAX = 40;
export const PROMPT_MAX = 12_000;

/** Design `AB_CATS`. */
export const CATEGORIES = ['FinOps', 'DevOps', 'ERP', 'Productivity', 'Security', 'Data'] as const;
export const TOKEN_OPTIONS = [1024, 2048, 4096, 8192] as const;
export const SECOND_OPTIONS = [30, 60, 120, 300, 600] as const;
export const ITERATIONS_MIN = 1;
export const ITERATIONS_MAX = 25;

/** Design: «Tokens por llamada» offers the same steps as the tokens of a response. */
export const PER_CALL_OPTIONS = TOKEN_OPTIONS;
/** Design: what the per-call controls show while the version does not set them. */
export const PER_CALL_DEFAULT = 4096;
export const TEMPERATURE_DEFAULT = 0.2;
/** Same limit as the API (`MAX_USERS`). */
export const USERS_MAX = 50;

export interface Template {
  id: 'blank' | 'finops' | 'devops' | 'docs';
  icon: string;
  color?: number;
  category?: string;
  description?: string;
  prompt?: string;
}

/**
 * Design `AB_TEMPLATES`. A template only fills identity and instructions: tools, access and
 * limits are always chosen by the creator.
 */
export const TEMPLATES: readonly Template[] = [
  { id: 'blank', icon: 'Plus' },
  {
    id: 'finops',
    icon: 'Money',
    color: 1,
    category: 'FinOps',
    description:
      'Analiza costos de AWS, detecta drivers de crecimiento y recomienda optimizaciones.',
    prompt:
      '# Instrucciones\n\nPrimero consulta Cost Explorer y luego Compute Optimizer.\nUsa tablas para comparativos. No inventes números.\nCierra con las 3 acciones de mayor ahorro.',
  },
  {
    id: 'devops',
    icon: 'Terminal',
    color: 2,
    category: 'DevOps',
    description: 'Revisa pipelines, logs y alarmas; propone rollbacks cuando algo falla.',
    prompt:
      '# Instrucciones\n\nAntes de proponer un rollback, confirma el último deploy estable.\nNunca ejecutes cambios sin aprobación.',
  },
  {
    id: 'docs',
    icon: 'BookOpen',
    color: 3,
    category: 'Productivity',
    description: 'Responde preguntas sobre políticas y documentación interna, citando la fuente.',
    prompt:
      '# Instrucciones\n\nCita siempre el documento y su fecha de actualización.\nSi no encuentras la respuesta, dilo.',
  },
];

/** What the installation offers; everything comes from the API. */
export interface BuilderContext {
  models: readonly Model[];
  catalog: readonly Connector[];
  groups: readonly Group[];
}

export interface ToolInfo {
  ref: string;
  connector: Connector | null;
  enabled: boolean;
  write: boolean;
  centralOnly: boolean;
}

/**
 * Every tool of the catalog by its reference. A tool can be chosen only while its server serves
 * it (`tools[].enabled`): during an update a pack may serve part of the tools it lists.
 */
export function toolIndex(catalog: readonly Connector[]): Map<string, ToolInfo> {
  const index = new Map<string, ToolInfo>();
  for (const connector of catalog) {
    for (const tool of connector.tools) {
      index.set(tool.ref, {
        ref: tool.ref,
        connector,
        enabled: connector.enabled && tool.enabled,
        write: tool.access === 'write',
        centralOnly: tool.central_groups_only,
      });
    }
  }
  return index;
}

export function blankDefinition(context: BuilderContext): Definition {
  const model = context.models[0]?.id ?? null;
  return {
    name: '',
    description: '',
    category: CATEGORIES[0],
    icon: 'Bot',
    color: 0,
    reports_to: null,
    role: '',
    model,
    allowed_models: model ? [model] : [],
    system_prompt: '',
    tools: [],
    approval_tools: [],
    limits: {
      max_tokens: 4096,
      max_iterations: 8,
      timeout_seconds: 120,
      max_tokens_per_call: null,
      temperature: null,
    },
    // Design: the access of a new agent starts empty.
    groups: [],
    users: [],
  };
}

export function applyTemplate(
  current: Definition,
  template: Template,
  label: string,
  context: BuilderContext,
): Definition {
  if (template.id === 'blank') return blankDefinition(context);
  return {
    ...current,
    name: label,
    description: template.description ?? '',
    category: template.category ?? current.category,
    icon: template.icon,
    color: template.color ?? 0,
    system_prompt: template.prompt ?? '',
  };
}

/** `[a, b, c]` as the backend stores sets: unique and sorted. */
const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();

/**
 * The definition as it is sent: trimmed texts, the design's default description and every
 * write tool marked for approval (the server rejects a write tool that is not).
 */
export function toInput(
  definition: Definition,
  context: BuilderContext,
  defaultDescription: string,
): DefinitionInput {
  const tools = toolIndex(context.catalog);
  const selected = new Set(definition.tools);
  const approval = [
    ...definition.approval_tools.filter((ref) => selected.has(ref)),
    ...definition.tools.filter((ref) => tools.get(ref)?.write),
  ];
  return {
    name: definition.name.trim(),
    description: definition.description.trim() || defaultDescription,
    category: definition.category.trim(),
    icon: definition.icon,
    color: definition.color,
    reports_to: definition.reports_to,
    role: definition.role.trim(),
    model: definition.model,
    allowed_models: sortedUnique(definition.allowed_models),
    system_prompt: definition.system_prompt,
    tools: sortedUnique(definition.tools),
    approval_tools: sortedUnique(approval),
    limits: { ...definition.limits },
    groups: sortedUnique(definition.groups),
    users: sortedUnique(definition.users),
  };
}

// --- Secrets (same patterns as mango_api.agent_rules; only the kind is ever shown) -------------

export type SecretKind = keyof typeof agentBuilder.secretKinds;

const SECRET_PATTERNS: readonly (readonly [SecretKind, RegExp])[] = [
  ['aws_access_key_id', /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/],
  ['aws_secret_access_key', /aws_?secret_?access_?key\s*[:=]/i],
  ['private_key', /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/],
  ['api_key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['bearer_token', /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
  ['password', /\b(?:password|passwd|pwd|contraseña)\s*[:=]\s*\S{4,}/i],
  ['credential', /\b(?:api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9/+_=-]{20,}/i],
];

/** Kinds of credentials that appear in `text`. The matches are never returned. */
export function findSecrets(text: string): SecretKind[] {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}

export function isSecretKind(value: string): value is SecretKind {
  return SECRET_PATTERNS.some(([kind]) => kind === value);
}

/** Text fields that are checked, in the order of the design (`SECRET_FIELDS`). */
const SECRET_FIELDS = ['system_prompt', 'description', 'name', 'role'] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

export function isSecretField(value: string): value is SecretField {
  return (SECRET_FIELDS as readonly string[]).includes(value);
}

/**
 * The first field that looks like it carries a credential (design `secretIn`): the kind and the
 * field, never the value.
 */
export function firstSecret(
  definition: Definition,
): { field: SecretField; kind: SecretKind } | null {
  for (const field of SECRET_FIELDS) {
    const kind = findSecrets(definition[field])[0];
    if (kind) return { field, kind };
  }
  return null;
}

// --- Problems ----------------------------------------------------------------------------------

export type ProblemKey = keyof typeof agentBuilder.problems;

/** One thing to fix, shown in the notice at the top and on its section. */
export interface Problem {
  /** Stable id: rule code plus field, to merge the client's and the server's findings. */
  id: string;
  key: ProblemKey;
  section: SectionId | null;
  /** Tool refs, group ids or model ids; for secrets, the kinds. Never free text. */
  items: string[];
  count?: number;
  max?: number;
  /** For secrets: the field it was found in (a field name, never its content). */
  field?: string;
  /** For the central-groups rule: the tools that answer for the whole organization. */
  tools?: string[];
}

const problem = (
  id: string,
  key: ProblemKey,
  section: SectionId | null,
  items: string[] = [],
): Problem => ({ id, key, section, items, count: items.length });

const FIELD_SECTION: Record<string, SectionId> = {
  name: 'identity',
  description: 'identity',
  category: 'identity',
  reports_to: 'org',
  role: 'org',
  system_prompt: 'brain',
  model: 'brain',
  allowed_models: 'brain',
  tools: 'tools',
  approval_tools: 'tools',
  groups: 'access',
  users: 'access',
};

/**
 * Wording of each server rule for the creator (design `AB_SERVER_ERR`): the server's texts name
 * no item, the page's own checks do. `secret_detected` is refined by its field.
 */
const RULE_KEYS: Record<RuleCode, ProblemKey> = {
  secret_detected: 'secret',
  tool_not_enabled: 'serverToolNotEnabled',
  prompt_required: 'promptRequired',
  reports_to_required: 'reportsToRequired',
  reports_to_cycle: 'reportsToCycle',
  reports_to_unknown: 'reportsToUnknown',
  role_required: 'roleRequired',
  groups_required: 'groupsRequired',
  definition_too_large: 'definitionTooLarge',
  model_required: 'modelRequired',
  default_model_not_allowed: 'defaultModelNotAllowed',
  model_not_enabled: 'serverModelNotEnabled',
  model_without_tools: 'serverModelWithoutTools',
  approval_tool_not_selected: 'approvalToolNotSelected',
  write_tool_without_approval: 'writeToolApproval',
  group_unknown: 'groupUnknown',
  account_data_for_non_central_group: 'serverAccountDataArea',
  account_data_for_users: 'serverAccountDataUsers',
};

/** Design `AB_SERVER_ERR`: where each rule points; the rest follow their field. */
const RULE_SECTION: Partial<Record<RuleCode, SectionId | null>> = {
  definition_too_large: null,
  write_tool_without_approval: 'tools',
  approval_tool_not_selected: 'tools',
  // The design files this rule under Tools: that is where its notice lives.
  account_data_for_non_central_group: 'tools',
  account_data_for_users: 'access',
};

/** A rule the server reported (`violations[]`), as something the creator can act on. */
export function problemOfViolation(violation: Violation): Problem {
  const { code, field, items } = violation;
  const id = `${code}:${field}`;
  if (!isRuleCode(code)) return problem(id, 'unknownRule', FIELD_SECTION[field] ?? null, [code]);
  const section =
    code in RULE_SECTION ? (RULE_SECTION[code] ?? null) : (FIELD_SECTION[field] ?? null);
  // Only the kind and the field of a secret are ever shown, never what matched.
  if (code === 'secret_detected') return { ...problem(id, 'secret', section, items), field };
  return problem(id, RULE_KEYS[code], section, items);
}

/** Models named by a definition, with names for the ones the installation still has. */
export function modelName(models: readonly Model[], id: string): string {
  return models.find((model) => model.id === id)?.name ?? id;
}

/**
 * The same rules of the server (`validate_for_review`), as far as the page can tell from what it
 * loaded, plus the name. `submitting` adds the ones that only matter when sending (design
 * `Lifecycle.validate`).
 */
export function precheck(
  definition: Definition,
  context: BuilderContext,
  options: { submitting?: boolean } = {},
): Problem[] {
  const out: Problem[] = [];
  if (!definition.name.trim()) out.push(problem('name_required:name', 'nameRequired', 'identity'));
  if (options.submitting && definition.reports_to === null) {
    out.push(problem('reports_to_required:reports_to', 'reportsToRequired', 'org'));
  }
  if (options.submitting && !definition.role.trim()) {
    out.push(problem('role_required:role', 'roleRequired', 'org'));
  }
  if (!definition.system_prompt.trim()) {
    out.push(problem('prompt_required:system_prompt', 'promptRequired', 'brain'));
  }

  const models = new Map(context.models.map((model) => [model.id, model]));
  if (definition.model === null) {
    out.push(problem('model_required:model', 'modelRequired', 'brain'));
  } else if (!definition.allowed_models.includes(definition.model)) {
    out.push(
      problem('default_model_not_allowed:allowed_models', 'defaultModelNotAllowed', 'brain'),
    );
  }
  const named = sortedUnique([
    ...definition.allowed_models,
    ...(definition.model ? [definition.model] : []),
  ]);
  const disabled = named.filter((id) => !models.has(id));
  if (disabled.length > 0) {
    out.push(problem('model_not_enabled:allowed_models', 'modelNotEnabled', 'brain', disabled));
  }
  const noTools = named.filter((id) => models.get(id)?.supports_tools === false);
  if (definition.tools.length > 0 && noTools.length > 0) {
    out.push(problem('model_without_tools:allowed_models', 'modelWithoutTools', 'brain', noTools));
  }

  const tools = toolIndex(context.catalog);
  const off = definition.tools.filter((ref) => !tools.get(ref)?.enabled);
  if (off.length > 0) {
    out.push(
      problem(
        'tool_not_enabled:tools',
        off.length === 1 ? 'toolNotEnabledOne' : 'toolNotEnabledMany',
        'tools',
        off,
      ),
    );
  }
  // Rule per tool (D35): only the tools that answer for the whole organization block.
  const central = definition.tools.filter((ref) => tools.get(ref)?.centralOnly);
  const exposed = nonCentralGroups(definition, context);
  if (central.length > 0 && exposed.length > 0) {
    out.push({
      ...problem('account_data_for_non_central_group:groups', 'accountDataArea', 'tools', exposed),
      tools: central,
    });
  }
  if (central.length > 0 && definition.users.length > 0) {
    out.push(problem('account_data_for_users:users', 'accountDataUsers', 'access'));
  }
  if (definition.groups.length === 0) {
    out.push(problem('groups_required:groups', 'groupsRequired', 'access'));
  }

  const secret = firstSecret(definition);
  if (secret) {
    out.push({
      ...problem(`secret_detected:${secret.field}`, 'secret', FIELD_SECTION[secret.field] ?? null, [
        secret.kind,
      ]),
      field: secret.field,
    });
  }
  return out;
}

/** Selected groups that are not central. An unknown group counts as not central (deny). */
export function nonCentralGroups(definition: Definition, context: BuilderContext): string[] {
  const types = new Map(context.groups.map((group) => [group.id, group.type]));
  return definition.groups.filter((id) => types.get(id) !== 'central');
}

/** Problems without repeats; the first finding of each rule and field wins. */
export function mergeProblems(...lists: Problem[][]): Problem[] {
  const seen = new Set<string>();
  return lists.flat().filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/**
 * A failed write as a problem. The server's `message` is never shown: the code picks a text of
 * the app.
 */
export function problemOfError(error: unknown, quotas: Quotas | null): Problem {
  const of = (key: ProblemKey, extra: Partial<Problem> = {}): Problem => ({
    id: `error:${key}`,
    key,
    section: null,
    items: [],
    ...extra,
  });
  if (!(error instanceof ApiError)) return of(error instanceof TypeError ? 'network' : 'generic');
  if (error.code === 'submission_limit' || error.status === 429) return of('dailyLimit');
  if (error.code === 'too_many_drafts') {
    return of('tooManyDrafts', quotas ? { count: quotas.drafts, max: quotas.max_drafts } : {});
  }
  if (error.status === 409) return of('versionConflict');
  if (error.status === 403) return of('forbidden');
  if (error.status === 400 || error.status === 422) return of('invalid');
  if (error.status === 503) return of('unavailable');
  return of('generic');
}

// --- Organization ------------------------------------------------------------------------------

/** Agents that report, directly or not, to `agentId`: they cannot be its supervisor. */
export function subordinatesOf(nodes: readonly OrgNode[], agentId: string): Set<string> {
  const below = new Set<string>();
  const walk = (id: string) => {
    for (const node of nodes) {
      if (node.reports_to === id && !below.has(node.id)) {
        below.add(node.id);
        walk(node.id);
      }
    }
  };
  walk(agentId);
  return below;
}

/** Published agents that may supervise `agentId` (itself and its subordinates are left out). */
export function supervisorOptions(nodes: readonly OrgNode[], agentId: string | null): OrgNode[] {
  if (agentId === null) return [...nodes];
  const below = subordinatesOf(nodes, agentId);
  return nodes.filter((node) => node.id !== agentId && !below.has(node.id));
}

// --- Changes -----------------------------------------------------------------------------------

function setChanges(before: readonly string[], after: readonly string[]): number {
  const old = new Set(before);
  const next = new Set(after);
  return (
    after.filter((item) => !old.has(item)).length + before.filter((item) => !next.has(item)).length
  );
}

const COUNTED_FIELDS = [
  'name',
  'description',
  'category',
  'icon',
  'color',
  'reports_to',
  'role',
  'model',
] as const;
const COUNTED_LIMITS = [
  'max_tokens',
  'max_iterations',
  'timeout_seconds',
  'max_tokens_per_call',
  'temperature',
] as const;

/**
 * Changes against the published version while editing (design `Lifecycle.diffCount`, without
 * the budget). Only a hint: the diff the reviewer sees is computed by the API, which also
 * counts the tools that ask for approval (derived here only when the version is sent).
 */
export function changeCount(base: Definition, definition: Definition): number {
  const fields = COUNTED_FIELDS.filter(
    (field) => (base[field] ?? '') !== (definition[field] ?? ''),
  ).length;
  const limits = COUNTED_LIMITS.filter(
    (field) => base.limits[field] !== definition.limits[field],
  ).length;
  return (
    fields +
    limits +
    (base.system_prompt === definition.system_prompt ? 0 : 1) +
    setChanges(base.allowed_models, definition.allowed_models) +
    setChanges(base.tools, definition.tools) +
    setChanges(base.groups, definition.groups) +
    setChanges(base.users, definition.users)
  );
}

/** Rough size of the prompt (design: characters / 4). */
export function promptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}

/** Agent ids as the API accepts them in a path: a generated id or a release slug. */
export const AGENT_ID_PATTERN = /^(?:[a-z2-7]{16}|[a-z][a-z0-9]{1,15})$/;
