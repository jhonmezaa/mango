import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../auth/useSession';
import { Alert } from '../../components/Alert';
import { Badge, type BadgeTone } from '../../components/Badge';
import { RefreshIcon } from '../../components/icons';
import { usePeople } from '../../directory/usePeople';
import { formatRelative } from '../../lib/format';
import { parseSkillRef, skillIssues } from '../agentBuilder/model';
import type { Skill } from '../skills/model';
import {
  ROOT_SUPERVISOR,
  fieldChange,
  otherChanges,
  ruleText,
  setChange,
  skillChanges,
  type Diff,
  type FieldValue,
  type ReferenceData,
  type Version,
} from './reviewModel';

function shown(value: FieldValue, none: string): string {
  return value === null || value === '' ? none : String(value);
}

/** Design `<s className="rv-old">before</s> → after`. Values are API text, rendered as text. */
function Changed({ before, after, strong }: { before: string; after: string; strong?: boolean }) {
  return (
    <>
      <s className="rv-old">{before}</s> → {strong ? <b>{after}</b> : after}
    </>
  );
}

/** Design `RvDiffLines`, with the lines the backend computed (the SPA never diffs). */
function DiffLines({ lines, label }: { lines: NonNullable<Diff['prompt']>; label: string }) {
  return (
    // Focusable so the keyboard can scroll a long prompt.
    <pre className="rv-diff" tabIndex={0} role="group" aria-label={label}>
      {lines.map((line, index) => (
        // The lines of a diff have no identity of their own and never reorder.
        <div key={index} className={line.op === '+' ? 'add' : line.op === '-' ? 'rem' : undefined}>
          <span>{line.op}</span>
          {line.text || ' '}
        </div>
      ))}
    </pre>
  );
}

const TIER_TONE: Record<string, BadgeTone> = {
  public: 'neutral',
  account_data: 'violet',
  write: 'amber',
};

function Sign({ kind }: { kind: 'add' | 'rem' }) {
  const { t } = useTranslation();
  return (
    <>
      <span className="rv-sign" aria-hidden="true">
        {kind === 'add' ? '+' : '−'}
      </span>
      <span className="sr-only">
        {kind === 'add' ? t('agentReview.detail.added') : t('agentReview.detail.removed')}
      </span>
    </>
  );
}

function ToolRow({
  toolRef,
  kind,
  tools,
  approval = false,
}: {
  toolRef: string;
  kind: 'add' | 'rem';
  tools: ReferenceData['tools'];
  /** The version asks for approval on every use of this tool. */
  approval?: boolean;
}) {
  const { t } = useTranslation();
  const info = tools?.get(toolRef);
  const tier = info?.dataTier;
  return (
    <li className={`rv-tool ${kind}`}>
      <Sign kind={kind} />
      <span className="mono">{toolRef}</span>
      {tier !== undefined && (
        <Badge tone={Object.hasOwn(TIER_TONE, tier) ? (TIER_TONE[tier] ?? 'neutral') : 'neutral'}>
          {tier === 'public' || tier === 'account_data' || tier === 'write'
            ? t(`agentReview.dataTier.${tier}`)
            : tier}
        </Badge>
      )}
      {info &&
        (info.write ? (
          <Badge tone="amber">{t('agentReview.tool.write')}</Badge>
        ) : approval ? (
          <Badge tone="amber">{t('agentReview.tool.approval')}</Badge>
        ) : (
          <Badge>{t('agentReview.tool.read')}</Badge>
        ))}
      {/* Without the catalog nothing is claimed about the tool; outside it, only this. */}
      {tools && !info?.enabled && <Badge tone="red">{t('agentReview.tool.notEnabled')}</Badge>}
    </li>
  );
}

/** Design `rv-chip`: the current values, with the added ones marked, then the removed ones. */
function Chips({
  values,
  added,
  removed,
  mono,
  tag,
  text,
}: {
  values: readonly string[];
  added: readonly string[];
  removed: readonly string[];
  mono?: boolean;
  tag?: (value: string) => string | null;
  /** What to show instead of a value (the email of a user); the value itself when undefined. */
  text?: (value: string) => string | undefined;
}) {
  const { t } = useTranslation();
  if (values.length === 0 && removed.length === 0) {
    return <span className="mk-meta">{t('agentReview.detail.none')}</span>;
  }
  const isAdded = new Set(added);
  // Monospace is for identifiers: a value shown by another text (an email) is not one.
  const base = (value: string) =>
    mono && text?.(value) === undefined ? 'rv-chip mono' : 'rv-chip';
  return (
    <ul className="rv-chips">
      {values.map((value) => {
        const label = tag?.(value);
        return (
          <li key={value} className={isAdded.has(value) ? `${base(value)} add` : base(value)}>
            {isAdded.has(value) && (
              <>
                <span aria-hidden="true">+</span>
                <span className="sr-only">{t('agentReview.detail.added')}</span>
              </>
            )}
            {text?.(value) ?? value}
            {label && <em>{label}</em>}
          </li>
        );
      })}
      {removed.map((value) => (
        <li key={`-${value}`} className={`${base(value)} rem`}>
          <span aria-hidden="true">−</span>
          <span className="sr-only">{t('agentReview.detail.removed')}</span>
          {text?.(value) ?? value}
        </li>
      ))}
    </ul>
  );
}

type KnowledgeRef = NonNullable<Version['knowledge_bases']>[number];

/**
 * One knowledge base added or removed (design `RvKbs`). An added one comes from the version, as
 * the registry has it now: its status and the groups of the agent that would get answers
 * without its content (D26, D88 (26)). A removed one is named from the list, when the reviewer
 * sees it.
 */
function KnowledgeRow({
  id,
  kind,
  current,
  known,
}: {
  id: string;
  kind: 'add' | 'rem';
  current: KnowledgeRef | undefined;
  known: { name: string; groups: readonly string[] } | undefined;
}) {
  const { t } = useTranslation();
  const name = current?.name ?? known?.name ?? null;
  const gone = kind === 'add' ? current !== undefined && current.name === null : false;
  const gap = kind === 'add' ? (current?.groups_without_access ?? []) : [];
  const status = kind === 'add' ? current?.status : null;
  return (
    <li className={`rv-tool ${kind}`}>
      <Sign kind={kind} />
      <span className="min-w-0 flex-1">
        <span className={name ? 'block' : 'mono block'}>{name ?? id}</span>
        {known && known.groups.length > 0 && (
          <span className="mono mk-meta text-[11.5px]">{known.groups.join(', ')}</span>
        )}
        {gap.length > 0 && (
          <span className="rv-kb-gap">
            <span className="mono">{gap.join(', ')}</span>{' '}
            {gap.length === 1 ? t('agentReview.kbs.gapOne') : t('agentReview.kbs.gapMany')}
          </span>
        )}
      </span>
      {gone ? (
        <Badge tone="red">{t('agentReview.kbs.gone')}</Badge>
      ) : status && status !== 'ok' ? (
        <Badge tone={status === 'error' ? 'red' : status === 'warn' ? 'amber' : 'neutral'}>
          {Object.hasOwn(KB_STATUS, status)
            ? t(`knowledge.status.${KB_STATUS[status] ?? 'pending'}`)
            : status}
        </Badge>
      ) : null}
    </li>
  );
}

/**
 * One skill added, removed or moved to another version (design `RvSkills`), named from the
 * catalog when the reviewer sees it. An added one says why it could not be published.
 */
function SkillRow({
  skillRefValue,
  kind,
  from,
  skills,
  tools,
}: {
  skillRefValue: string;
  kind: 'add' | 'rem' | 'chg';
  from?: string;
  skills: ReadonlyMap<string, Skill> | null;
  tools: readonly string[];
}) {
  const { t } = useTranslation();
  const { id, version } = parseSkillRef(skillRefValue);
  const skill = skills?.get(id);
  const name = skill?.name ?? id;
  const issues = kind === 'rem' || skills === null ? [] : skillIssues(skillRefValue, skill, tools);
  return (
    <li className={`rv-tool ${kind === 'rem' ? 'rem' : 'add'}`}>
      {kind === 'chg' ? (
        <>
          <span className="rv-sign" aria-hidden="true">
            ~
          </span>
          <span className="sr-only">{t('agentReview.skills.changed')}</span>
        </>
      ) : (
        <Sign kind={kind} />
      )}
      <span className="min-w-0 flex-1">
        <span className="block">{name}</span>
        <span className="mono mk-meta text-[11.5px]">
          {kind === 'chg' && from
            ? t('agentReview.skills.version', {
                id,
                from: parseSkillRef(from).version,
                to: version,
              })
            : skillRefValue}
        </span>
        {issues.map((issue) => (
          <span
            key={`${issue.kind}:${'server' in issue ? issue.server : ''}`}
            className="rv-sk-issue"
          >
            {issue.kind === 'unapproved'
              ? t('agentBuilder.problems.skillUnapproved', {
                  items: `${name} v${String(issue.version)}`,
                })
              : t(
                  issue.kind === 'serverOff'
                    ? 'agentBuilder.problems.skillServerOff'
                    : 'agentBuilder.problems.skillServerMissing',
                  { items: name, tools: issue.server },
                )}
          </span>
        ))}
      </span>
    </li>
  );
}

/** The stored status of a knowledge base, as the Knowledge Bases screen names it. */
const KB_STATUS: Readonly<Record<string, 'pending' | 'syncing' | 'warn' | 'error' | 'deleting'>> = {
  pending: 'pending',
  syncing: 'syncing',
  warn: 'warn',
  error: 'error',
  deleting: 'deleting',
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mk-sec-t">{title}</h3>
      {children}
    </section>
  );
}

const LIMITS = [
  ['max_tokens', 'maxTokens'],
  ['max_iterations', 'maxIterations'],
  ['timeout_seconds', 'timeoutSeconds'],
  ['max_tokens_per_call', 'maxTokensPerCall'],
  ['temperature', 'temperature'],
] as const;

/**
 * Every section of the design's diff, from `diff` and `definition` of the API: the SPA never
 * compares versions itself. Everything is API text and is rendered as text.
 */
export function VersionDiff({
  version,
  refs,
  onReevaluate,
}: {
  version: Version;
  refs: ReferenceData;
  /** Reads the version again, so the API evaluates the publication rules once more. */
  onReevaluate: () => void;
}) {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const { definition, diff } = version;
  const isNew = diff.is_new;
  const none = t('agentReview.detail.none');
  const supervisor = (id: FieldValue) =>
    id === null || id === ''
      ? none
      : id === ROOT_SUPERVISOR
        ? t('agentReview.detail.rootSupervisor')
        : (refs.agentNames.get(String(id)) ?? String(id));

  const reportsTo = fieldChange(diff, 'reports_to');
  const role = fieldChange(diff, 'role');
  const info = (['name', 'description', 'category', 'icon', 'color', 'model'] as const).flatMap(
    (field) => {
      const change = fieldChange(diff, field);
      return change ? [{ field, ...change }] : [];
    },
  );
  const models = setChange(diff, 'allowed_models');
  const modelsChanged = models.added.length > 0 || models.removed.length > 0;
  const tools = setChange(diff, 'tools');
  const approval = setChange(diff, 'approval_tools');
  const groups = setChange(diff, 'groups');
  const users = setChange(diff, 'users');
  const kbs = setChange(diff, 'knowledge_bases');
  const kbRefs = new Map((version.knowledge_bases ?? []).map((ref) => [ref.kb_id, ref]));
  const kbAdded = isNew ? definition.knowledge_bases : kbs.added;
  const skillSet = setChange(diff, 'skills');
  const skills = isNew
    ? { added: definition.skills, removed: [], changed: [] }
    : skillChanges(skillSet.added, skillSet.removed);
  const skillsChanged = skills.added.length + skills.removed.length + skills.changed.length > 0;
  // People by email for whoever may look them up (creators and administrators; the server
  // decides). An identifier the directory does not answer for stays as it is.
  const people = usePeople(
    api,
    [...definition.users, ...users.removed],
    me.is_admin || me.can.create_agent,
  );
  const other = otherChanges(diff);
  const otherCount = other.fields.length + other.sets.length;
  const asksApproval = new Set(definition.approval_tools);
  const violations = version.violations;
  const groupTag = (group: string) => {
    const type = refs.groupTypes.get(group);
    return type === 'area' || type === 'general' ? t(`agentReview.groupType.${type}`) : null;
  };
  const who = version.created_by_email ?? version.created_by;

  return (
    <div className="ap-sections">
      <div>
        <h2 className="ap-h2">{definition.name}</h2>
        <p className="ap-impact">{definition.description}</p>
        <div className="mk-meta ap-by">
          {t('agentReview.detail.madeBy')} <b>{who}</b>
          {version.submitted_at &&
            ` · ${t('agentReview.detail.sent', { when: formatRelative(version.submitted_at) })}`}
          {!isNew && ` · ${t('agentReview.detail.stillActive')}`}
        </div>
      </div>

      {violations === null && (
        <Alert tone="amber" role="status">
          <div className="ap-alert-t">{t('agentReview.detail.rulesUnknownTitle')}</div>
          <div className="ap-alert-i">{t('agentReview.detail.rulesUnknownBody')}</div>
          <button type="button" className="btn btn-sm ap-alert-a" onClick={onReevaluate}>
            <RefreshIcon size={12} /> {t('agentReview.detail.reevaluate')}
          </button>
        </Alert>
      )}
      {violations !== null && violations.length > 0 && (
        <Alert tone="red">
          <div className="ap-alert-t">{t('agentReview.detail.rulesTitle')}</div>
          <ul>
            {violations.map((violation) => (
              <li key={`${violation.code}/${violation.field}`} className="ap-alert-i">
                · {ruleText(t, violation)}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {(isNew || reportsTo || role) && (
        <Section title={t('agentReview.detail.organization')}>
          <div className="ap-facts">
            <div>
              <span>{t('agentReview.detail.reportsTo')}</span>
              <span>
                {reportsTo ? (
                  <Changed
                    before={supervisor(reportsTo.before)}
                    after={supervisor(reportsTo.after)}
                  />
                ) : (
                  supervisor(definition.reports_to)
                )}
              </span>
            </div>
            <div>
              <span>{t('agentReview.detail.role')}</span>
              <span>
                {role ? (
                  <Changed before={shown(role.before, none)} after={shown(role.after, none)} />
                ) : (
                  definition.role || none
                )}
              </span>
            </div>
          </div>
        </Section>
      )}

      {isNew ? (
        <Section title={t('agentReview.detail.information')}>
          <div className="ap-facts">
            <div>
              <span>{t('agentReview.detail.category')}</span>
              <span>{definition.category || none}</span>
            </div>
            <div>
              <span>{t('agentReview.detail.model')}</span>
              <span className="mono">{definition.model ?? none}</span>
            </div>
            <div>
              <span>{t('agentReview.detail.allowedModels')}</span>
              <span>
                <Chips values={definition.allowed_models} added={[]} removed={[]} mono />
              </span>
            </div>
          </div>
        </Section>
      ) : (
        (info.length > 0 || modelsChanged) && (
          <Section title={t('agentReview.detail.information')}>
            <div className="ap-facts">
              {info.map(({ field, before, after }) => (
                <div key={field}>
                  <span>{t(`agentReview.detail.${field}`)}</span>
                  {field === 'description' ? (
                    <span>
                      <s className="rv-old">{shown(before, none)}</s>
                      <br />
                      {shown(after, none)}
                    </span>
                  ) : (
                    <span className={field === 'model' ? 'mono' : undefined}>
                      <Changed before={shown(before, none)} after={shown(after, none)} />
                    </span>
                  )}
                </div>
              ))}
              {modelsChanged && (
                <div>
                  <span>{t('agentReview.detail.allowedModels')}</span>
                  <ul className="mono rv-lines">
                    {models.added.map((model) => (
                      <li key={model} className="add">
                        <Sign kind="add" /> {model}
                      </li>
                    ))}
                    {models.removed.map((model) => (
                      <li key={`-${model}`} className="rem">
                        <Sign kind="rem" /> {model}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Section>
        )
      )}

      <Section
        title={
          isNew
            ? t('agentReview.detail.prompt')
            : diff.prompt
              ? t('agentReview.detail.promptChanged')
              : t('agentReview.detail.promptSame')
        }
      >
        {diff.prompt ? (
          <DiffLines lines={diff.prompt} label={t('agentReview.detail.prompt')} />
        ) : (
          <div className="mk-meta">{isNew ? none : t('agentReview.detail.noChanges')}</div>
        )}
      </Section>

      <Section
        title={
          isNew
            ? t('agentReview.detail.toolsNew', { count: definition.tools.length })
            : t('agentReview.detail.toolsChanged', {
                added: tools.added.length,
                removed: tools.removed.length,
              })
        }
      >
        {tools.added.length > 0 || tools.removed.length > 0 ? (
          <ul className="rv-tools">
            {tools.added.map((ref) => (
              <ToolRow
                key={ref}
                toolRef={ref}
                kind="add"
                tools={refs.tools}
                approval={asksApproval.has(ref)}
              />
            ))}
            {tools.removed.map((ref) => (
              <ToolRow key={`-${ref}`} toolRef={ref} kind="rem" tools={refs.tools} />
            ))}
          </ul>
        ) : (
          <div className="mk-meta rv-none">
            {isNew ? none : t('agentReview.detail.toolsSame', { count: definition.tools.length })}
          </div>
        )}
        {!isNew && (approval.added.length > 0 || approval.removed.length > 0) && (
          <div className="rv-approval">
            <div className="mk-meta rv-sub">{t('agentReview.detail.approvalTools')}</div>
            <ul className="rv-tools">
              {approval.added.map((ref) => (
                <li key={ref} className="rv-tool add">
                  <Sign kind="add" />
                  <span className="mono">{ref}</span>
                  <Badge tone="amber">{t('agentReview.detail.asksApproval')}</Badge>
                </li>
              ))}
              {approval.removed.map((ref) => (
                <li key={`-${ref}`} className="rv-tool rem">
                  <Sign kind="rem" />
                  <span className="mono">{ref}</span>
                  <Badge>{t('agentReview.detail.noLongerApproval')}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {(!isNew || definition.knowledge_bases.length > 0) && (
        <Section
          title={
            isNew
              ? t('agentReview.kbs.titleNew', { count: definition.knowledge_bases.length })
              : t('agentReview.kbs.titleChanged', {
                  added: kbs.added.length,
                  removed: kbs.removed.length,
                })
          }
        >
          {kbAdded.length > 0 || kbs.removed.length > 0 ? (
            <ul className="rv-tools">
              {kbAdded.map((id) => (
                <KnowledgeRow
                  key={id}
                  id={id}
                  kind="add"
                  current={kbRefs.get(id)}
                  known={refs.knowledge.get(id)}
                />
              ))}
              {kbs.removed.map((id) => (
                <KnowledgeRow
                  key={`-${id}`}
                  id={id}
                  kind="rem"
                  current={undefined}
                  known={refs.knowledge.get(id)}
                />
              ))}
            </ul>
          ) : (
            <div className="mk-meta rv-none">
              {t('agentReview.kbs.same', { count: definition.knowledge_bases.length })}
            </div>
          )}
        </Section>
      )}

      {(!isNew || definition.skills.length > 0) && (
        <Section
          title={
            isNew
              ? t('agentReview.skills.titleNew', { count: definition.skills.length })
              : t('agentReview.skills.titleChanged', {
                  added: skills.added.length,
                  removed: skills.removed.length,
                  changed: skills.changed.length,
                })
          }
        >
          {skillsChanged ? (
            <ul className="rv-tools">
              {skills.added.map((ref) => (
                <SkillRow
                  key={ref}
                  skillRefValue={ref}
                  kind="add"
                  skills={refs.skills}
                  tools={definition.tools}
                />
              ))}
              {skills.changed.map(({ ref, from }) => (
                <SkillRow
                  key={`~${ref}`}
                  skillRefValue={ref}
                  from={from}
                  kind="chg"
                  skills={refs.skills}
                  tools={definition.tools}
                />
              ))}
              {skills.removed.map((ref) => (
                <SkillRow
                  key={`-${ref}`}
                  skillRefValue={ref}
                  kind="rem"
                  skills={refs.skills}
                  tools={definition.tools}
                />
              ))}
            </ul>
          ) : (
            <div className="mk-meta rv-none">
              {t('agentReview.skills.same', { count: definition.skills.length })}
            </div>
          )}
        </Section>
      )}

      <Section title={t('agentReview.detail.access')}>
        <div className="mk-meta rv-sub">{t('agentReview.detail.groups')}</div>
        <Chips
          values={definition.groups}
          added={isNew ? [] : groups.added}
          removed={groups.removed}
          tag={groupTag}
        />
        {(definition.users.length > 0 || users.removed.length > 0) && (
          <>
            <div className="mk-meta rv-sub is-next">{t('agentReview.detail.users')}</div>
            <Chips
              values={definition.users}
              added={isNew ? [] : users.added}
              removed={users.removed}
              mono
              text={people.emailOf}
            />
          </>
        )}
      </Section>

      <Section title={t('agentReview.detail.limits')}>
        <div className="ap-facts">
          {LIMITS.map(([field, label]) => {
            const change = fieldChange(diff, `limits.${field}`);
            const value = definition.limits[field];
            return (
              <div key={field}>
                <span>{t(`agentReview.detail.${label}`)}</span>
                <span className="mono">
                  {change ? (
                    <Changed
                      before={shown(change.before, none)}
                      after={shown(change.after, none)}
                      strong
                    />
                  ) : (
                    shown(value, none)
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </Section>

      {otherCount > 0 && (
        <Section title={t('agentReview.detail.other', { count: otherCount })}>
          <div className="mk-meta rv-note">{t('agentReview.detail.otherNote')}</div>
          <div className="ap-facts">
            {other.fields.map((change) => (
              <div key={change.field}>
                <span className="mono">{change.field}</span>
                <span>
                  <Changed before={shown(change.before, none)} after={shown(change.after, none)} />
                </span>
              </div>
            ))}
            {other.sets.map((change) => (
              <div key={change.field}>
                <span className="mono">{change.field}</span>
                <span>
                  <Chips values={change.added} added={change.added} removed={change.removed} mono />
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
