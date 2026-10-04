import type { TFunction } from 'i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';

import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { useToasts } from '../../components/admin/useToasts';
import { Alert } from '../../components/Alert';
import { Badge, type BadgeTone } from '../../components/Badge';
import { CheckIcon, InfoIcon, LockIcon, X2Icon } from '../../components/icons';
import { Topbar } from '../../components/Topbar';
import { usePeople } from '../../directory/usePeople';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { formatRelative } from '../../lib/format';
import { BuilderAside } from './BuilderAside';
import { BuilderBarMenu } from './BuilderBarMenu';
import {
  SECTION_IDS,
  applyTemplate,
  changeCount,
  firstSecret,
  isSecretField,
  isSecretKind,
  mergeProblems,
  modelName,
  nonCentralGroups,
  precheck,
  problemOfError,
  problemOfViolation,
  supervisorOptions,
  toInput,
  toolIndex,
  type Definition,
  type Model,
  type Problem,
  type SectionId,
  type Template,
  type Version,
} from './model';
import {
  AccessSection,
  BrainSection,
  IdentitySection,
  LimitsSection,
  OrgSection,
  ToolsSection,
  type BudgetInfo,
} from './sections';
import type { BuilderData } from './useBuilderData';

/** Where the Marketplace reads what the Builder just did (router state, never the URL). */
export type BuilderNotice = 'draft_saved' | 'submitted';

/** A version that was sent can no longer be edited (design `locked`). */
const LOCKED_STATUSES = new Set(['in_review', 'approved', 'published', 'superseded', 'retired']);

type StatusKey =
  'draft' | 'in_review' | 'rejected' | 'approved' | 'published' | 'failed' | 'retired';
const STATUS_TONE: Record<StatusKey, BadgeTone> = {
  draft: 'neutral',
  in_review: 'amber',
  rejected: 'red',
  approved: 'blue',
  published: 'green',
  failed: 'red',
  retired: 'neutral',
};

/** Design `REV_STATUS`: a rejected version is a draft that carries the reviewer's reason. */
function statusKey(version: Version): StatusKey | null {
  if (version.status === 'draft') return version.rejection_reason ? 'rejected' : 'draft';
  return version.status in STATUS_TONE ? (version.status as StatusKey) : null;
}

/** Design `EXPIRED_STEP` fallback: a failed publication with no step recorded. */
const EXPIRED_STEP = 'publication_expired';

/** The agent a copy was made from (router state set by «Duplicar»): a name, shown as text. */
function clonedFromOf(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('clonedFrom' in state)) return null;
  const name = state.clonedFrom;
  return typeof name === 'string' && name.length > 0 && name.length <= 80 ? name : null;
}

/**
 * Items of a problem as text: names for models, at most three refs and, for a secret, only its
 * kind and the field it is in (never what matched).
 */
function problemText(t: TFunction, item: Problem, models: readonly Model[]): string {
  if (item.key === 'secret') {
    const field = item.field ?? '';
    return t('agentBuilder.problems.secret', {
      items: item.items
        .slice(0, 3)
        .map((kind) => (isSecretKind(kind) ? t(`agentBuilder.secretKinds.${kind}`) : kind))
        .join(', '),
      field: t(`agentBuilder.secretFields.${isSecretField(field) ? field : 'other'}`),
    });
  }
  const items =
    item.key === 'modelNotEnabled' || item.key === 'modelWithoutTools'
      ? item.items.map((id) => modelName(models, id))
      : item.items;
  const tools = item.tools ?? [];
  return t(`agentBuilder.problems.${item.key}`, {
    items: items.slice(0, 3).join(', '),
    // Design: the first two tools, then an ellipsis.
    tools: tools.slice(0, 2).join(', ') + (tools.length > 2 ? '…' : ''),
    count: item.count ?? items.length,
    max: item.max ?? 0,
  });
}

interface Failure {
  action: 'save' | 'submit';
  items: Problem[];
}

const SCROLL_OFFSET = 140;

/** The Builder once its data is loaded (design admin.jsx `AgentAdmin`). */
export function BuilderForm({ data }: { data: BuilderData }) {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const navigate = useNavigate();
  const { notify, stack } = useToasts();
  const clonedFrom = clonedFromOf(useLocation().state);
  // Design: at ≤560 px the bar keeps «Enviar» and the rest goes to the «⋯» menu.
  const narrowBar = useMediaQuery('(max-width: 560px)');
  const { context, nodes, quotas, budgets, draft } = data;

  const [snap, setSnap] = useState<Definition>(draft.initial);
  // The stored version: it changes when a write goes through, even if a later step fails.
  const [live, setLive] = useState<Version | null>(draft.version);
  const [template, setTemplate] = useState<Template['id']>('blank');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<Failure['action'] | 'reopen' | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>('identity');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Whoever is here may create agents, which is what the directory endpoint asks for.
  const people = usePeople(api, snap.users, true);
  const locked = live !== null && LOCKED_STATUSES.has(live.status);
  const isChange = draft.kind === 'change';

  const change = useCallback(
    (patch: Partial<Definition>) => {
      if (locked) return;
      setSnap((current) => ({ ...current, ...patch }));
      setFailure(null);
    },
    [locked],
  );

  const pre = useMemo(() => precheck(snap, context), [snap, context]);
  const pending = useMemo(
    () => new Set(pre.flatMap((item) => (item.section ? [item.section] : []))),
    [pre],
  );
  const tools = useMemo(() => toolIndex(context.catalog), [context.catalog]);
  const writeCount = snap.tools.filter((ref) => tools.get(ref)?.write).length;
  const areaGroups = useMemo(() => nonCentralGroups(snap, context), [snap, context]);
  const supervisors = useMemo(
    () => supervisorOptions(nodes, draft.agentId),
    [nodes, draft.agentId],
  );
  const changes = draft.base ? changeCount(draft.base, snap) : 0;
  const secret = useMemo(() => firstSecret(snap), [snap]);

  const budget = useMemo((): BudgetInfo | null => {
    if (!budgets) return null;
    const fallback = budgets.defaults.agent_monthly_usd;
    const own = budgets.agents.find((item) => item.agent_id === draft.agentId);
    if (!isChange || !own) return { limitUsd: fallback, kind: 'default' };
    const isDefault = Number(own.limit_usd) === Number(fallback);
    return { limitUsd: own.limit_usd, kind: isDefault ? 'default' : 'own' };
  }, [budgets, draft.agentId, isChange]);

  // Section under the top of the scroll area (design: scroll spy over `.content`).
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onScroll = () => {
      let current: SectionId = 'identity';
      for (const id of SECTION_IDS) {
        const element = root.querySelector<HTMLElement>(`#ab-${id}`);
        if (element && element.offsetTop - root.scrollTop < SCROLL_OFFSET) current = id;
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = 'access';
      setActiveSection(current);
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
    };
  }, []);

  const goTo = useCallback((section: SectionId | null) => {
    const root = scrollRef.current;
    if (!root) return;
    const element = section ? root.querySelector<HTMLElement>(`#ab-${section}`) : null;
    root.scrollTo({ top: element ? element.offsetTop - 24 : 0, behavior: 'smooth' });
  }, []);

  const pickTemplate = useCallback(
    (item: Template) => {
      setTemplate(item.id);
      setFailure(null);
      setSnap((current) =>
        applyTemplate(current, item, t(`agentBuilder.identity.templates.${item.id}`), context),
      );
    },
    [context, t],
  );

  const fail = (action: Failure['action'], items: Problem[]) => {
    setFailure({ action, items });
    goTo(null);
  };

  /**
   * Stores what is on screen as a draft and returns the stored version: creates the agent or
   * the new version the first time, reopens a failed publication and saves only if it changed.
   */
  const persist = async (): Promise<Version> => {
    const input = toInput(
      snap,
      context,
      t('agentBuilder.identity.defaultDescription', { category: snap.category }),
    );
    let current = live;
    if (!current) {
      if (draft.agentId === null) {
        current = await api.call('postAgent', { body: { definition: input } });
        setLive(current);
        return current;
      }
      current = await api.call('postVersion', { path: { agent_id: draft.agentId }, body: {} });
      setLive(current);
    }
    const path = { agent_id: current.agent_id, version: current.version };
    if (current.status === 'failed') {
      current = await api.call('reopenVersion', { path, body: {} });
      setLive(current);
    }
    const stored = toInput(current.definition, context, current.definition.description);
    if (JSON.stringify(stored) !== JSON.stringify(input)) {
      current = await api.call('putVersion', {
        path,
        body: { revision: current.revision, definition: input },
      });
      setLive(current);
    }
    return current;
  };

  const leave = (notice: BuilderNotice) => {
    void navigate('/marketplace', { state: { builderNotice: notice } });
  };

  const saveDraft = async () => {
    if (!snap.name.trim()) {
      fail('save', [
        { id: 'name_required:name', key: 'nameRequiredToSave', section: 'identity', items: [] },
      ]);
      return;
    }
    setBusy('save');
    try {
      await persist();
      leave('draft_saved');
    } catch (error) {
      fail('save', [problemOfError(error, quotas)]);
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    // Help only: the same rules run on the server, and those are the ones that count.
    const local = precheck(snap, context, { submitting: true });
    if (local.length > 0) {
      fail('submit', local);
      return;
    }
    setBusy('submit');
    let saved: Version | null = null;
    try {
      saved = await persist();
      await api.call('submitVersion', {
        path: { agent_id: saved.agent_id, version: saved.version },
        body: { revision: saved.revision },
      });
      leave('submitted');
    } catch (error) {
      if (saved && error instanceof ApiError && error.code === 'validation_failed') {
        fail('submit', await serverProblems(saved, error));
      } else {
        fail('submit', [problemOfError(error, quotas)]);
      }
    } finally {
      setBusy(null);
    }
  };

  /** Design «Reabrir como borrador»: a failed publication becomes a draft that can be fixed. */
  const reopen = async () => {
    if (live?.status !== 'failed') return;
    setBusy('reopen');
    setFailure(null);
    try {
      const reopened = await api.call('reopenVersion', {
        path: { agent_id: live.agent_id, version: live.version },
        body: {},
      });
      setLive(reopened);
      notify(t('agentBuilder.toasts.reopened'));
    } catch (error) {
      fail('save', [problemOfError(error, quotas)]);
    } finally {
      setBusy(null);
    }
  };

  /**
   * Rules the server found on a rejected submission: the ones the 422 carries. An answer
   * without them (an older API) falls back to the version, which reports the same rules.
   */
  const serverProblems = async (version: Version, error: ApiError): Promise<Problem[]> => {
    if (error.violations && error.violations.length > 0) {
      return mergeProblems(error.violations.map(problemOfViolation));
    }
    try {
      const fresh = await api.call('readVersion', {
        path: { agent_id: version.agent_id, version: version.version },
      });
      setLive(fresh);
      const found = mergeProblems((fresh.violations ?? []).map(problemOfViolation));
      if (found.length > 0) return found;
    } catch {
      // Fall through: the submission was rejected either way.
    }
    return [{ id: 'error:invalid', key: 'invalid', section: null, items: [] }];
  };

  const has = (...keys: Problem['key'][]) =>
    failure?.items.some((item) => keys.includes(item.key)) ?? false;

  const status = live ? statusKey(live) : null;
  const title = isChange ? t('agentBuilder.editAgent') : t('agentBuilder.newAgent');
  const crumb = isChange
    ? (draft.base?.name ?? snap.name)
    : snap.name || t('agentBuilder.newAgent');
  const failureTitle = failure
    ? failure.items.length === 1
      ? t(`agentBuilder.errors.${failure.action}One`)
      : t(`agentBuilder.errors.${failure.action}Many`, { count: failure.items.length })
    : '';

  return (
    <>
      <Topbar
        crumbs={[t('agentBuilder.crumbRoot'), crumb]}
        actions={
          locked ? (
            <Link to="/marketplace" className="btn btn-sm">
              {t('agentBuilder.actions.back')}
            </Link>
          ) : narrowBar ? (
            <>
              <BuilderBarMenu
                disabled={busy !== null}
                onSaveDraft={() => void saveDraft()}
                onCancel={() => void navigate('/marketplace')}
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy !== null}
                onClick={() => void submit()}
              >
                {t('agentBuilder.actions.submitShort')}
              </button>
            </>
          ) : (
            <>
              <Link to="/marketplace" className="btn btn-sm btn-ghost">
                {t('agentBuilder.actions.cancel')}
              </Link>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() => void saveDraft()}
              >
                {t('agentBuilder.actions.saveDraft')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy !== null}
                onClick={() => void submit()}
              >
                {t('agentBuilder.actions.submit')}
              </button>
            </>
          )
        }
      />
      <div className="content" ref={scrollRef}>
        <div className="ab-grid">
          <nav className="ab-nav" aria-label={t('agentBuilder.sectionsLabel')}>
            {SECTION_IDS.map((id, index) => {
              const done = !pending.has(id);
              return (
                <button
                  key={id}
                  type="button"
                  className={activeSection === id ? 'ab-nav-item is-active' : 'ab-nav-item'}
                  aria-current={activeSection === id ? 'true' : undefined}
                  onClick={() => {
                    goTo(id);
                  }}
                >
                  <span className={done ? 'ab-step is-done' : 'ab-step'}>
                    {done ? <CheckIcon size={10} /> : index + 1}
                  </span>
                  {t(`agentBuilder.sections.${id}`)}
                </button>
              );
            })}
          </nav>

          <div className="ab-form">
            <div className="ab-head">
              <div className="ab-head-row">
                <h1>{title}</h1>
                {status && (
                  <Badge tone={STATUS_TONE[status]}>{t(`agentBuilder.status.${status}`)}</Badge>
                )}
              </div>
              <p>{isChange ? t('agentBuilder.introChange') : t('agentBuilder.introNew')}</p>
            </div>

            {locked && (
              <Alert tone="amber" icon={<LockIcon size={14} />} className="ab-notice">
                <b>
                  {live.status === 'in_review' || live.status === 'approved'
                    ? t(`agentBuilder.locked.${live.status}`)
                    : status
                      ? t(`agentBuilder.status.${status}`)
                      : live.status}
                </b>
                {live.status === 'in_review' &&
                  live.submitted_at &&
                  t('agentBuilder.locked.since', { when: formatRelative(live.submitted_at) })}
                {t('agentBuilder.locked.body')}
                {me.is_admin && (
                  <>
                    {' '}
                    <Link to="/review" className="ab-link">
                      {t('agentBuilder.locked.seeReview')}
                    </Link>
                  </>
                )}
              </Alert>
            )}
            {clonedFrom && live?.status === 'draft' && !live.rejection_reason && (
              <Alert icon={<CheckIcon size={14} />} role="status" className="ab-notice">
                {t('agentBuilder.cloned.before')}
                <b>{clonedFrom}</b>
                {t('agentBuilder.cloned.after')}
              </Alert>
            )}
            {!locked && isChange && (
              <Alert icon={<InfoIcon size={14} />} className="ab-notice">
                {t('agentBuilder.change.editingDraftOf')}
                <b>{draft.base?.name}</b>
                {t('agentBuilder.change.stillActive')}
                {changes > 0 && (
                  <>
                    {' · '}
                    <b>{changes}</b>{' '}
                    {changes === 1
                      ? t('agentBuilder.change.changeOne')
                      : t('agentBuilder.change.changeMany')}{' '}
                    {t('agentBuilder.change.soFar')}
                  </>
                )}
              </Alert>
            )}
            {status === 'rejected' && live && (
              <Alert tone="red" icon={<X2Icon size={14} />} className="ab-notice">
                <b>
                  {live.rejected_by_email
                    ? t('agentBuilder.rejected.titleBy', { who: live.rejected_by_email })
                    : t('agentBuilder.rejected.title')}
                </b>{' '}
                “{live.rejection_reason}” {t('agentBuilder.rejected.body')}
              </Alert>
            )}
            {live?.status === 'failed' && (
              <Alert tone="red" icon={<X2Icon size={14} />} className="ab-notice">
                <b>{t('agentBuilder.failed.title')}</b>
                {t('agentBuilder.failed.step', { step: live.failed_step ?? EXPIRED_STEP })}
                {t('agentBuilder.failed.body')}{' '}
                <button
                  type="button"
                  className="ab-link"
                  disabled={busy !== null}
                  onClick={() => void reopen()}
                >
                  {t('agentBuilder.failed.reopen')}
                </button>
              </Alert>
            )}
            {failure && (
              <Alert tone="red" role="alert" className="ab-notice">
                <div className="ab-notice-title">{failureTitle}</div>
                {failure.items.map((item) => (
                  <div key={item.id} className="ab-notice-line">
                    · {problemText(t, item, context.models)}{' '}
                    {item.section && (
                      <button
                        type="button"
                        className="ab-link"
                        onClick={() => {
                          goTo(item.section);
                        }}
                      >
                        {t('agentBuilder.actions.go')}
                      </button>
                    )}
                  </div>
                ))}
              </Alert>
            )}

            <fieldset disabled={locked} className="ab-fieldset">
              <IdentitySection
                name={snap.name}
                description={snap.description}
                category={snap.category}
                icon={snap.icon}
                color={snap.color}
                template={!isChange && live === null ? template : null}
                nameError={has('nameRequired', 'nameRequiredToSave')}
                descriptionSecret={secret?.field === 'description' ? secret.kind : null}
                onChange={change}
                onTemplate={pickTemplate}
              />
              <OrgSection
                reportsTo={snap.reports_to}
                role={snap.role}
                supervisors={supervisors}
                reportsToError={has('reportsToRequired', 'reportsToCycle', 'reportsToUnknown')}
                roleError={has('roleRequired')}
                onChange={change}
              />
              <BrainSection
                model={snap.model}
                allowedModels={snap.allowed_models}
                prompt={snap.system_prompt}
                promptSecret={secret?.field === 'system_prompt' ? secret.kind : null}
                models={context.models}
                onChange={change}
              />
              <ToolsSection
                tools={snap.tools}
                catalog={context.catalog}
                areaGroups={areaGroups}
                userCount={snap.users.length}
                onChange={change}
              />
              <LimitsSection
                limits={snap.limits}
                budget={budget}
                canSeeBudgets={me.is_admin}
                onChange={change}
              />
              <AccessSection
                groups={snap.groups}
                registry={context.groups}
                groupsError={has('groupsRequired')}
                users={snap.users}
                emailOf={people.emailOf}
                onLookup={people.lookup}
                usersError={has('accountDataUsers', 'serverAccountDataUsers')}
                canSeeSettings={me.is_admin}
                myGroups={me.groups}
                myId={me.user_id}
                onChange={change}
              />
            </fieldset>
          </div>

          <BuilderAside
            name={snap.name}
            description={snap.description}
            category={snap.category}
            icon={snap.icon}
            color={snap.color}
            modelName={snap.model ? modelName(context.models, snap.model) : ''}
            toolCount={snap.tools.length}
            writeCount={writeCount}
            budgetUsd={budget?.limitUsd ?? null}
            pending={pending}
            ready={pre.length === 0}
            quotas={quotas}
            onGo={goTo}
          />
        </div>
      </div>
      {stack}
    </>
  );
}
