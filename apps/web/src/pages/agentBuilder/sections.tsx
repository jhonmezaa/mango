import { Fragment, memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Alert } from '../../components/Alert';
import { Badge, type BadgeTone } from '../../components/Badge';
import { CheckIcon, CloseIcon, LockIcon, PlusIcon, WarnIcon } from '../../components/icons';
import { isEmail, type LookupResult, type People } from '../../directory/usePeople';
import { formatUsd } from '../../lib/format';
import { AgentIcon } from './AgentIcon';
import { AGENT_ICON_COLORS, ALL_ICONS, CURATED_ICONS, agentColor } from './agentIcons';
import { BuilderField, BuilderSection } from './fields';
import {
  CATEGORIES,
  DESCRIPTION_MAX,
  ITERATIONS_MAX,
  ITERATIONS_MIN,
  NAME_MAX,
  PER_CALL_DEFAULT,
  PER_CALL_OPTIONS,
  PROMPT_MAX,
  ROLE_MAX,
  ROOT_SUPERVISOR,
  SECOND_OPTIONS,
  TEMPERATURE_DEFAULT,
  TEMPLATES,
  TOKEN_OPTIONS,
  USERS_MAX,
  promptTokens,
  toolIndex,
  type Connector,
  type Definition,
  type Group,
  type Model,
  type OrgNode,
  type SecretKind,
  type Template,
} from './model';

// The six sections of the form (design admin.jsx). Each one gets only the fields it edits and
// `onChange`, which the form ignores while the version is locked.

export type Change = (patch: Partial<Definition>) => void;

const toggled = (list: readonly string[], item: string): string[] =>
  list.includes(item) ? list.filter((other) => other !== item) : [...list, item];

// --- Información básica ------------------------------------------------------------------------

interface IdentityProps {
  name: string;
  description: string;
  category: string;
  icon: string;
  color: number;
  /** Selected template, or null when templates are not offered (a saved or existing agent). */
  template: Template['id'] | null;
  nameError: boolean;
  /** Kind of the credential the description seems to carry; the value is never shown. */
  descriptionSecret: SecretKind | null;
  onChange: Change;
  onTemplate: (template: Template) => void;
}

export const IdentitySection = memo(function IdentitySection({
  name,
  description,
  category,
  icon,
  color,
  template,
  nameError,
  descriptionSecret,
  onChange,
  onTemplate,
}: IdentityProps) {
  const { t } = useTranslation();
  const [allIcons, setAllIcons] = useState(false);
  const tone = agentColor(color);
  // An agent may carry a category or an icon outside the design's lists: it stays selectable.
  const categories =
    (CATEGORIES as readonly string[]).includes(category) || !category
      ? CATEGORIES
      : [...CATEGORIES, category];
  const shown = allIcons ? ALL_ICONS : CURATED_ICONS;
  const icons = shown.includes(icon) ? shown : [...shown, icon];

  return (
    <BuilderSection
      id="identity"
      title={t('agentBuilder.sections.identity')}
      desc={t('agentBuilder.identity.desc')}
    >
      {template !== null && (
        <BuilderField label={t('agentBuilder.identity.template')}>
          {({ labelId }) => (
            <div className="ab-templates" role="group" aria-labelledby={labelId}>
              {TEMPLATES.map((item) => {
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={template === item.id ? 'ab-tpl is-on' : 'ab-tpl'}
                    aria-pressed={template === item.id}
                    onClick={() => {
                      onTemplate(item);
                    }}
                  >
                    {item.id === 'blank' ? (
                      <PlusIcon size={14} />
                    ) : (
                      <AgentIcon name={item.icon} size={14} />
                    )}
                    <span>{t(`agentBuilder.identity.templates.${item.id}`)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </BuilderField>
      )}
      <div className="ab-row">
        <div className="ab-avatar" style={{ background: tone.bg, color: tone.color }}>
          <AgentIcon name={icon} size={26} />
        </div>
        <div className="ab-row-fields">
          <BuilderField
            control
            label={t('agentBuilder.identity.name')}
            error={nameError && t('agentBuilder.identity.nameError')}
          >
            {({ controlId, errorId }) => (
              <input
                id={controlId}
                className="input"
                value={name}
                maxLength={NAME_MAX}
                placeholder={t('agentBuilder.identity.namePlaceholder')}
                aria-invalid={nameError || undefined}
                aria-describedby={errorId}
                autoComplete="off"
                onChange={(event) => {
                  onChange({ name: event.target.value });
                }}
              />
            )}
          </BuilderField>
          <BuilderField
            control
            label={t('agentBuilder.identity.description')}
            hint={`${description.length}/${DESCRIPTION_MAX}`}
            error={
              descriptionSecret &&
              t('agentBuilder.identity.secret', {
                kind: t(`agentBuilder.secretKinds.${descriptionSecret}`),
              })
            }
          >
            {({ controlId, errorId }) => (
              <textarea
                id={controlId}
                className="input"
                rows={2}
                maxLength={DESCRIPTION_MAX}
                value={description}
                placeholder={t('agentBuilder.identity.descriptionPlaceholder')}
                aria-invalid={descriptionSecret ? true : undefined}
                aria-describedby={errorId}
                onChange={(event) => {
                  onChange({ description: event.target.value });
                }}
              />
            )}
          </BuilderField>
        </div>
      </div>
      <BuilderField label={t('agentBuilder.identity.category')}>
        {({ labelId }) => (
          <div className="ab-seg" role="group" aria-labelledby={labelId}>
            {categories.map((item) => (
              <button
                key={item}
                type="button"
                className={category === item ? 'is-on' : undefined}
                aria-pressed={category === item}
                onClick={() => {
                  onChange({ category: item });
                }}
              >
                {item}
              </button>
            ))}
          </div>
        )}
      </BuilderField>
      <BuilderField label={t('agentBuilder.identity.iconAndColor')}>
        {() => (
          <>
            <div className="ab-icons" role="group" aria-label={t('agentBuilder.identity.icons')}>
              {icons.map((item) => {
                const on = icon === item;
                return (
                  <button
                    key={item}
                    type="button"
                    title={item}
                    aria-label={item}
                    aria-pressed={on}
                    style={
                      on
                        ? {
                            background: tone.bg,
                            color: tone.color,
                            borderColor: `${tone.color}66`,
                          }
                        : undefined
                    }
                    onClick={() => {
                      onChange({ icon: item });
                    }}
                  >
                    <AgentIcon name={item} size={15} />
                  </button>
                );
              })}
            </div>
            <div className="ab-colors">
              <div
                className="ab-swatches"
                role="group"
                aria-label={t('agentBuilder.identity.colors')}
              >
                {AGENT_ICON_COLORS.map((item, index) => (
                  <button
                    key={item.name}
                    type="button"
                    className="ab-swatch"
                    aria-label={t('agentBuilder.identity.color', { name: item.name })}
                    aria-pressed={color === index}
                    style={{
                      background: item.color,
                      boxShadow:
                        color === index ? `0 0 0 2px var(--bg), 0 0 0 4px ${item.color}` : 'none',
                    }}
                    onClick={() => {
                      onChange({ color: index });
                    }}
                  />
                ))}
              </div>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setAllIcons((value) => !value);
                }}
              >
                {allIcons
                  ? t('agentBuilder.identity.fewerIcons')
                  : t('agentBuilder.identity.allIcons')}
              </button>
            </div>
          </>
        )}
      </BuilderField>
    </BuilderSection>
  );
});

// --- Organización ------------------------------------------------------------------------------

interface OrgProps {
  reportsTo: string | null;
  role: string;
  /** Published agents that may supervise this one. */
  supervisors: readonly OrgNode[];
  reportsToError: boolean;
  roleError: boolean;
  onChange: Change;
}

export const OrgSection = memo(function OrgSection({
  reportsTo,
  role,
  supervisors,
  reportsToError,
  roleError,
  onChange,
}: OrgProps) {
  const { t } = useTranslation();
  const known =
    reportsTo === null ||
    reportsTo === ROOT_SUPERVISOR ||
    supervisors.some((node) => node.id === reportsTo);
  return (
    <BuilderSection
      id="org"
      title={t('agentBuilder.sections.org')}
      desc={t('agentBuilder.org.desc')}
    >
      <div className="ab-2col">
        <BuilderField
          control
          label={t('agentBuilder.org.reportsTo')}
          hint={t('agentBuilder.org.reportsToHint')}
          error={reportsToError && t('agentBuilder.org.reportsToError')}
        >
          {({ controlId, errorId }) => (
            <select
              id={controlId}
              className="input"
              value={reportsTo ?? ''}
              aria-invalid={reportsToError || undefined}
              aria-describedby={errorId}
              onChange={(event) => {
                onChange({ reports_to: event.target.value || null });
              }}
            >
              <option value="" disabled>
                {t('agentBuilder.org.choose')}
              </option>
              <option value={ROOT_SUPERVISOR}>{t('agentBuilder.org.platform')}</option>
              {supervisors.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.role ? `${node.name} · ${node.role}` : node.name}
                </option>
              ))}
              {!known && (
                <option value={reportsTo}>
                  {t('agentBuilder.org.unavailable', { id: reportsTo })}
                </option>
              )}
            </select>
          )}
        </BuilderField>
        <BuilderField
          control
          label={t('agentBuilder.org.role')}
          hint={`${role.length}/${ROLE_MAX}`}
          error={roleError && t('agentBuilder.org.roleError')}
        >
          {({ controlId, errorId }) => (
            <input
              id={controlId}
              className="input"
              value={role}
              maxLength={ROLE_MAX}
              placeholder={t('agentBuilder.org.rolePlaceholder')}
              aria-invalid={roleError || undefined}
              aria-describedby={errorId}
              autoComplete="off"
              onChange={(event) => {
                onChange({ role: event.target.value });
              }}
            />
          )}
        </BuilderField>
      </div>
    </BuilderSection>
  );
});

// --- Modelo e instrucciones --------------------------------------------------------------------

const priceFormat = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 4 });

/** USD per million tokens, from the API's decimal string. Unparseable input is shown as is. */
function price(amount: string): string {
  const value = Number(amount);
  return Number.isFinite(value) ? priceFormat.format(value) : amount;
}

interface BrainProps {
  model: string | null;
  allowedModels: readonly string[];
  prompt: string;
  /** Kind of the credential the instructions seem to carry; the value is never shown. */
  promptSecret: SecretKind | null;
  /** Enabled models of the installation (GET /api/models). */
  models: readonly Model[];
  onChange: Change;
}

export const BrainSection = memo(function BrainSection({
  model,
  allowedModels,
  prompt,
  promptSecret: secret,
  models,
  onChange,
}: BrainProps) {
  const { t } = useTranslation();
  const defaultEnabled = model === null || models.some((item) => item.id === model);

  const setDefault = (id: string) => {
    onChange({
      model: id,
      allowed_models: allowedModels.includes(id) ? [...allowedModels] : [...allowedModels, id],
    });
  };

  return (
    <BuilderSection
      id="brain"
      title={t('agentBuilder.sections.brain')}
      desc={t('agentBuilder.brain.desc')}
    >
      <BuilderField
        label={t('agentBuilder.brain.defaultModel')}
        hint={t('agentBuilder.brain.defaultModelHint')}
      >
        {({ labelId }) => (
          <div className="ab-models" role="radiogroup" aria-labelledby={labelId}>
            {models.map((item) => {
              const on = item.id === model;
              const details = item.supports_tools
                ? item.provider
                : `${item.provider} · ${t('agentBuilder.brain.noTools')}`;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={on ? 'ab-model is-on' : 'ab-model'}
                  onClick={() => {
                    setDefault(item.id);
                  }}
                >
                  <span className="ab-radio" />
                  <span className="ab-model-text">
                    <span className="ab-model-name">{item.name}</span>
                    <span className="ab-model-sub">{details}</span>
                  </span>
                  <span className="mono ab-model-price">
                    {t('agentBuilder.brain.price', {
                      input: price(item.input_usd),
                      output: price(item.output_usd),
                    })}
                  </span>
                </button>
              );
            })}
            {!defaultEnabled && (
              <button type="button" role="radio" aria-checked className="ab-model is-on">
                <span className="ab-radio" />
                <span className="ab-model-text">
                  <span className="ab-model-name">{model}</span>
                  <span className="ab-model-sub is-off">{t('agentBuilder.brain.notEnabled')}</span>
                </span>
              </button>
            )}
            {models.length === 0 && defaultEnabled && (
              <div className="ab-empty">{t('agentBuilder.brain.noModels')}</div>
            )}
          </div>
        )}
      </BuilderField>
      <BuilderField
        label={t('agentBuilder.brain.allowedModels')}
        hint={t('agentBuilder.brain.allowedModelsHint')}
      >
        {({ labelId }) => (
          <div className="ab-list" role="group" aria-labelledby={labelId}>
            {models.map((item) => {
              const on = allowedModels.includes(item.id);
              const isDefault = item.id === model;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={on ? 'ab-item is-on' : 'ab-item'}
                  aria-pressed={on}
                  disabled={isDefault}
                  title={isDefault ? t('agentBuilder.brain.defaultAlwaysAllowed') : undefined}
                  onClick={() => {
                    onChange({ allowed_models: toggled(allowedModels, item.id) });
                  }}
                >
                  <span className="ab-check">{on && <CheckIcon size={10} />}</span>
                  <span className="ab-item-text">
                    <span className="ab-item-name">{item.name}</span>
                    <span className="ab-sub">{item.provider}</span>
                  </span>
                  {isDefault && <Badge tone="accent">{t('agentBuilder.brain.defaultBadge')}</Badge>}
                </button>
              );
            })}
          </div>
        )}
      </BuilderField>
      <BuilderField
        control
        label={t('agentBuilder.brain.prompt')}
        hint={t('agentBuilder.brain.promptTokens', { count: promptTokens(prompt) })}
        error={
          secret &&
          t('agentBuilder.brain.secret', { kind: t(`agentBuilder.secretKinds.${secret}`) })
        }
      >
        {({ controlId, errorId }) => (
          <textarea
            id={controlId}
            className="input mono ab-prompt"
            rows={9}
            maxLength={PROMPT_MAX}
            value={prompt}
            placeholder={t('agentBuilder.brain.promptPlaceholder')}
            aria-invalid={secret ? true : undefined}
            aria-describedby={errorId}
            spellCheck={false}
            onChange={(event) => {
              onChange({ system_prompt: event.target.value });
            }}
          />
        )}
      </BuilderField>
    </BuilderSection>
  );
});

// --- Tools -------------------------------------------------------------------------------------

type Level = 'public' | 'account_data' | 'write';
const LEVEL_TONE: Record<Level, BadgeTone> = {
  public: 'neutral',
  account_data: 'violet',
  write: 'amber',
};
const isLevel = (value: string): value is Level => value in LEVEL_TONE;

/** Data level of a connector (design `McpLevel`). */
function LevelBadge({ connector }: { connector: Connector }) {
  const { t } = useTranslation();
  const level = connector.data_tier;
  if (!isLevel(level)) return <Badge>{level}</Badge>;
  // The design's hint for account data ("solo roles centrales") only holds when the connector
  // has tools the server does not filter per user (D35).
  const centralOnly = connector.tools.some((tool) => tool.central_groups_only);
  const title =
    level === 'account_data' && !centralOnly
      ? undefined
      : t(`agentBuilder.tools.levelTitles.${level}`);
  return (
    <Badge tone={LEVEL_TONE[level]} {...(title ? { title } : {})}>
      {t(`agentBuilder.tools.levels.${level}`)}
    </Badge>
  );
}

interface ToolsProps {
  tools: readonly string[];
  /** Connectors and packs of the release (GET /api/mcp/catalog), enabled or not. */
  catalog: readonly Connector[];
  /** Selected groups that are not central: tools for central groups block the submission. */
  areaGroups: readonly string[];
  /** People the agent is shared with one by one: the same tools block the submission too. */
  userCount: number;
  onChange: Change;
}

export const ToolsSection = memo(function ToolsSection({
  tools,
  catalog,
  areaGroups,
  userCount,
  onChange,
}: ToolsProps) {
  const { t } = useTranslation();
  const index = useMemo(() => toolIndex(catalog), [catalog]);
  const selected = useMemo(() => new Set(tools), [tools]);
  // Only what an agent can use now: the servers with a tool they serve, and those tools.
  const enabled = catalog.flatMap((connector) => {
    const served = connector.tools.filter((tool) => index.get(tool.ref)?.enabled);
    return served.length > 0 ? [{ ...connector, tools: served }] : [];
  });
  const off = tools.filter((ref) => !index.get(ref)?.enabled);
  const writeCount = tools.filter((ref) => index.get(ref)?.write).length;
  const centralOnly = tools.some((ref) => index.get(ref)?.centralOnly);

  const toggleConnector = (connector: Connector) => {
    const refs = connector.tools.map((tool) => tool.ref);
    const all = refs.every((ref) => selected.has(ref));
    onChange({
      tools: all ? tools.filter((ref) => !refs.includes(ref)) : [...new Set([...tools, ...refs])],
    });
  };

  return (
    <BuilderSection
      id="tools"
      title={t('agentBuilder.sections.tools')}
      desc={t('agentBuilder.tools.desc')}
    >
      {off.length > 0 && (
        <Alert tone="red">
          <div className="ab-notice-title">
            {off.length === 1 ? t('agentBuilder.tools.offOne') : t('agentBuilder.tools.offMany')}
          </div>
          {off.map((ref) => (
            <div key={ref} className="ab-off-row">
              <span className="mono">{ref}</span>
              <span className="flex items-center gap-2">
                <span className="mk-meta">
                  {index.has(ref)
                    ? t('agentBuilder.tools.offDisabled')
                    : t('agentBuilder.tools.offMissing')}
                </span>
                <button
                  type="button"
                  className="ab-link"
                  onClick={() => {
                    onChange({ tools: tools.filter((other) => other !== ref) });
                  }}
                >
                  {t('agentBuilder.actions.remove')}
                </button>
              </span>
            </div>
          ))}
        </Alert>
      )}
      {centralOnly && (areaGroups.length > 0 || userCount > 0) && (
        <Alert tone="amber" icon={<WarnIcon size={14} />}>
          {t('agentBuilder.tools.warnBefore')}
          <b>{t('agentBuilder.tools.warnLevel')}</b>
          {t('agentBuilder.tools.warnVisible')}
          {areaGroups.length > 0 &&
            t('agentBuilder.tools.warnGroups', { groups: areaGroups.join(', ') })}
          {areaGroups.length > 0 && userCount > 0 && t('agentBuilder.tools.warnAnd')}
          {userCount > 0 && t('agentBuilder.tools.warnUsers')}
          {t('agentBuilder.tools.warnAfter')}
        </Alert>
      )}
      <div className="ab-list ab-list-tools">
        {enabled.length === 0 && <div className="ab-empty">{t('agentBuilder.tools.empty')}</div>}
        {enabled.map((connector) => {
          const all = connector.tools.every((tool) => selected.has(tool.ref));
          return (
            <Fragment key={connector.id}>
              <div className="ab-group">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="ab-group-name">{connector.name}</span>
                  <span>
                    {connector.kind === 'pack'
                      ? t('agentBuilder.tools.pack')
                      : t('agentBuilder.tools.connector')}
                  </span>
                  <LevelBadge connector={connector} />
                </span>
                <button
                  type="button"
                  className="ab-link"
                  onClick={() => {
                    toggleConnector(connector);
                  }}
                >
                  {all ? t('agentBuilder.tools.none') : t('agentBuilder.tools.all')}
                </button>
              </div>
              {connector.tools.map((tool) => {
                const on = selected.has(tool.ref);
                return (
                  <button
                    key={tool.ref}
                    type="button"
                    className={on ? 'ab-item is-on' : 'ab-item'}
                    aria-pressed={on}
                    onClick={() => {
                      onChange({ tools: toggled(tools, tool.ref) });
                    }}
                  >
                    <span className="ab-check">{on && <CheckIcon size={10} />}</span>
                    <span className="ab-item-text">
                      <span className="mono ab-item-name">{tool.name}</span>
                      <span className="ab-sub">{tool.description}</span>
                    </span>
                    {tool.central_groups_only && (
                      <Badge tone="violet" title={t('agentBuilder.tools.centralOnlyTitle')}>
                        {t('agentBuilder.tools.centralOnly')}
                      </Badge>
                    )}
                    {tool.requires_service ? (
                      <Badge
                        tone="amber"
                        title={t('agentBuilder.tools.requiresServiceTitle', {
                          service: tool.requires_service,
                        })}
                      >
                        {t('agentBuilder.tools.requiresService', {
                          service: tool.requires_service,
                        })}
                      </Badge>
                    ) : null}
                    {tool.access === 'write' ? (
                      <Badge tone="amber" title={t('agentBuilder.tools.writeTitle')}>
                        {t('agentBuilder.tools.write')}
                      </Badge>
                    ) : (
                      <Badge>{t('agentBuilder.tools.read')}</Badge>
                    )}
                  </button>
                );
              })}
            </Fragment>
          );
        })}
      </div>
      <div className="ab-foot">
        <span>
          {tools.length === 1
            ? t('agentBuilder.tools.countOne', { count: 1 })
            : t('agentBuilder.tools.countMany', { count: tools.length })}
          {writeCount > 0 && t('agentBuilder.tools.writeCount', { count: writeCount })}
        </span>
        <Link to="/mcp" className="ab-link">
          {t('agentBuilder.tools.missing')}
        </Link>
      </div>
    </BuilderSection>
  );
});

// --- Límites -----------------------------------------------------------------------------------

const tokenFormat = new Intl.NumberFormat('es-MX');
const temperatureFormat = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 1 });

/** What the page knows about the agent's monthly budget (admins only: GET /api/admin/budgets). */
export interface BudgetInfo {
  limitUsd: string;
  kind: 'default' | 'own';
}

interface LimitsProps {
  limits: Definition['limits'];
  /** Null when the caller cannot see budgets (the amount is then «—»). */
  budget: BudgetInfo | null;
  /** Presupuestos is an admin screen: only admins see the amount and its link (the API decides). */
  canSeeBudgets: boolean;
  onChange: Change;
}

/** Steps of a token limit; a current value outside them is said and kept (design: FinOps). */
function TokenSteps({
  labelId,
  options,
  value,
  onPick,
}: {
  labelId: string;
  options: readonly number[];
  value: number;
  onPick: (value: number) => void;
}) {
  return (
    <div className="ab-seg" role="group" aria-labelledby={labelId}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={value === option ? 'is-on' : undefined}
          aria-pressed={value === option}
          onClick={() => {
            onPick(option);
          }}
        >
          {tokenFormat.format(option)}
        </button>
      ))}
    </div>
  );
}

export const LimitsSection = memo(function LimitsSection({
  limits,
  budget,
  canSeeBudgets,
  onChange,
}: LimitsProps) {
  const { t } = useTranslation();
  const setLimit = (patch: Partial<Definition['limits']>) => {
    onChange({ limits: { ...limits, ...patch } });
  };
  const kept = (value: number, options: readonly number[]) =>
    options.includes(value)
      ? undefined
      : t('agentBuilder.limits.kept', { value: tokenFormat.format(value) });
  // Until the version sets them, the controls show the design's defaults and nothing is stored.
  const perCall = limits.max_tokens_per_call ?? PER_CALL_DEFAULT;
  const temperature = limits.temperature ?? TEMPERATURE_DEFAULT;
  return (
    <BuilderSection
      id="limits"
      title={t('agentBuilder.sections.limits')}
      desc={t('agentBuilder.limits.desc')}
    >
      <BuilderField
        label={t('agentBuilder.limits.tokens')}
        hint={kept(limits.max_tokens, TOKEN_OPTIONS)}
      >
        {({ labelId }) => (
          <TokenSteps
            labelId={labelId}
            options={TOKEN_OPTIONS}
            value={limits.max_tokens}
            onPick={(value) => {
              setLimit({ max_tokens: value });
            }}
          />
        )}
      </BuilderField>
      <div className="ab-2col">
        <BuilderField
          control
          label={t('agentBuilder.limits.iterations')}
          hint={t('agentBuilder.limits.iterationsHint')}
        >
          {({ controlId }) => (
            <div className="ab-range">
              <input
                id={controlId}
                type="range"
                min={ITERATIONS_MIN}
                max={ITERATIONS_MAX}
                value={limits.max_iterations}
                onChange={(event) => {
                  setLimit({ max_iterations: Number(event.target.value) });
                }}
              />
              <span className="ab-pct">{limits.max_iterations}</span>
            </div>
          )}
        </BuilderField>
        <BuilderField label={t('agentBuilder.limits.time')}>
          {({ labelId }) => (
            <div className="ab-seg" role="group" aria-labelledby={labelId}>
              {SECOND_OPTIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={limits.timeout_seconds === value ? 'is-on' : undefined}
                  aria-pressed={limits.timeout_seconds === value}
                  onClick={() => {
                    setLimit({ timeout_seconds: value });
                  }}
                >
                  {value < 60
                    ? t('agentBuilder.limits.seconds', { n: value })
                    : t('agentBuilder.limits.minutes', { n: value / 60 })}
                </button>
              ))}
            </div>
          )}
        </BuilderField>
      </div>
      <div className="ab-2col">
        <BuilderField
          label={t('agentBuilder.limits.perCall')}
          hint={
            (limits.max_tokens_per_call !== null &&
              kept(limits.max_tokens_per_call, PER_CALL_OPTIONS)) ||
            t('agentBuilder.limits.perCallHint')
          }
        >
          {({ labelId }) => (
            <TokenSteps
              labelId={labelId}
              options={PER_CALL_OPTIONS}
              value={perCall}
              onPick={(value) => {
                setLimit({ max_tokens_per_call: value });
              }}
            />
          )}
        </BuilderField>
        <BuilderField
          control
          label={t('agentBuilder.limits.temperature')}
          hint={t('agentBuilder.limits.temperatureHint')}
        >
          {({ controlId }) => (
            <div className="ab-range">
              <input
                id={controlId}
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={temperature}
                onChange={(event) => {
                  setLimit({ temperature: Number(event.target.value) });
                }}
              />
              <span className="ab-pct">{temperatureFormat.format(temperature)}</span>
            </div>
          )}
        </BuilderField>
      </div>
      <BuilderField
        label={t('agentBuilder.limits.budget')}
        hint={t('agentBuilder.limits.budgetHint')}
      >
        {() => (
          <div className="ab-budget">
            <div className="ro-field mono">
              <LockIcon size={12} />
              {canSeeBudgets && budget
                ? formatUsd(budget.limitUsd)
                : t('agentBuilder.limits.budgetUnknown')}
            </div>
            {canSeeBudgets ? (
              <>
                {budget && (
                  <span className="mk-meta">
                    {budget.kind === 'own'
                      ? t('agentBuilder.limits.budgetOwn')
                      : t('agentBuilder.limits.budgetDefault')}
                  </span>
                )}
                <Link to="/budgets" className="ab-link">
                  {t('agentBuilder.limits.seeBudgets')}
                </Link>
              </>
            ) : (
              <span className="mk-meta">{t('agentBuilder.limits.budgetAdminsOnly')}</span>
            )}
          </div>
        )}
      </BuilderField>
    </BuilderSection>
  );
});

// --- Acceso ------------------------------------------------------------------------------------

/** Why a person could not be added by email. */
type LookupError = Exclude<LookupResult['kind'], 'found'>;

interface AccessProps {
  groups: readonly string[];
  /** Group registry of the installation (GET /api/groups). */
  registry: readonly Group[];
  groupsError: boolean;
  /** People the version is shared with one by one, as the API stores them (user identifiers). */
  users: readonly string[];
  /** Email of one of those identifiers, when the directory gave it (shown instead of the id). */
  emailOf: People['emailOf'];
  /** Finds a person by email in the directory; the server authorizes, limits and audits it. */
  onLookup: People['lookup'];
  /** Tools for central groups are selected together with people: the version cannot be sent. */
  usersError: boolean;
  /** Ajustes is an admin screen; others are told an administrator manages the groups. */
  canSeeSettings: boolean;
  onChange: Change;
}

export const AccessSection = memo(function AccessSection({
  groups,
  registry,
  groupsError,
  users,
  emailOf,
  onLookup,
  usersError,
  canSeeSettings,
  onChange,
}: AccessProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [lookupError, setLookupError] = useState<LookupError | null>(null);
  const [looking, setLooking] = useState(false);
  const email = query.trim().toLowerCase();
  const invalid = email !== '' && !isEmail(email);
  const full = users.length >= USERS_MAX;

  const addPerson = async () => {
    if (email === '' || invalid || looking || full) return;
    setLooking(true);
    const result = await onLookup(email);
    setLooking(false);
    if (result.kind !== 'found') {
      setLookupError(result.kind);
      return;
    }
    setQuery('');
    // Design: adding someone who is already there changes nothing.
    if (!users.includes(result.id)) onChange({ users: [...users, result.id] });
  };
  // A group the agent already has but the registry lost stays visible, so it can be removed.
  const known = new Set(registry.map((group) => group.id));
  const stale = groups.filter((id) => !known.has(id));
  return (
    <BuilderSection
      id="access"
      title={t('agentBuilder.sections.access')}
      desc={t('agentBuilder.access.desc')}
    >
      <BuilderField
        label={t('agentBuilder.access.groups')}
        error={groupsError && t('agentBuilder.access.groupsError')}
      >
        {({ labelId }) => (
          <div className="ab-chips" role="group" aria-labelledby={labelId}>
            {registry.length + stale.length === 0 && (
              <span className="mk-meta">{t('agentBuilder.access.noGroups')}</span>
            )}
            {registry.map((group) => {
              const on = groups.includes(group.id);
              return (
                <button
                  key={group.id}
                  type="button"
                  className={on ? 'ab-chip is-on' : 'ab-chip'}
                  aria-pressed={on}
                  title={group.description || undefined}
                  onClick={() => {
                    onChange({ groups: toggled(groups, group.id) });
                  }}
                >
                  {on && <CheckIcon size={10} />}
                  {group.id}
                  {group.type !== 'central' && (
                    <span className="ab-area">
                      {group.type === 'area' && group.area
                        ? t('agentBuilder.access.area', { area: group.area })
                        : t('agentBuilder.access.noAccountData')}
                    </span>
                  )}
                </button>
              );
            })}
            {stale.map((id) => (
              <button
                key={id}
                type="button"
                className="ab-chip is-on"
                aria-pressed
                onClick={() => {
                  onChange({ groups: toggled(groups, id) });
                }}
              >
                <CheckIcon size={10} />
                {id}
              </button>
            ))}
          </div>
        )}
      </BuilderField>
      <BuilderField
        label={t('agentBuilder.access.users')}
        hint={t('agentBuilder.access.usersHint')}
        error={
          invalid
            ? t('agentBuilder.access.usersInvalid')
            : lookupError
              ? t(`agentBuilder.access.usersLookup.${lookupError}`)
              : full && email !== ''
                ? t('agentBuilder.access.usersMax', { max: USERS_MAX })
                : usersError && t('agentBuilder.access.usersError')
        }
      >
        {({ labelId, errorId }) => (
          <>
            {users.length > 0 && (
              <ul className="ab-chips ab-people" aria-labelledby={labelId}>
                {users.map((user) => {
                  // The email from the directory, or the identifier when there is none: both
                  // are API data, rendered as text.
                  const known = emailOf(user);
                  return (
                    <li key={user} className="ab-chip is-on ab-person">
                      <span className={known ? undefined : 'mono'}>{known ?? user}</span>
                      <button
                        type="button"
                        aria-label={t('agentBuilder.access.usersRemove', { user: known ?? user })}
                        onClick={() => {
                          onChange({ users: users.filter((other) => other !== user) });
                        }}
                      >
                        <CloseIcon size={10} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="ab-person-add">
              <input
                className="input"
                type="email"
                autoComplete="off"
                maxLength={254}
                placeholder={t('agentBuilder.access.usersPlaceholder')}
                aria-label={t('agentBuilder.access.usersAddLabel')}
                aria-invalid={invalid || lookupError !== null || undefined}
                aria-describedby={errorId}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLookupError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  // Never submits anything: the form has no submit of its own.
                  event.preventDefault();
                  void addPerson();
                }}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={email === '' || invalid || looking || full}
                onClick={() => void addPerson()}
              >
                {t('agentBuilder.access.usersAdd')}
              </button>
            </div>
          </>
        )}
      </BuilderField>
      <div className="mk-meta ab-note">
        {t('agentBuilder.access.noteBefore')}
        <b>{t('agentBuilder.access.noteCentral')}</b>
        {t('agentBuilder.access.noteAfter')}
        {canSeeSettings ? (
          <>
            {t('agentBuilder.access.noteAdmins')}
            <Link to="/settings" className="ab-link">
              {t('agentBuilder.access.settingsGroups')}
            </Link>
            .
          </>
        ) : (
          t('agentBuilder.access.noteOthers')
        )}
      </div>
    </BuilderSection>
  );
});
