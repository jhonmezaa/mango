import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { adminErrorKey, apiErrorCode } from '../../api/adminErrors';
import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { Denied, GovErrorState, Skel } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import { PlusIcon, SearchIcon, SkillIcon } from '../../components/icons';
import { Topbar } from '../../components/Topbar';
import {
  AVAILABILITY_FILTERS,
  LEVEL_FILTERS,
  NO_FILTERS,
  QUERY_MAX_LENGTH,
  SKILL_ID,
  copyName,
  creationChanges,
  decisionErrorCode,
  filtered,
  hasFilters,
  inAvailability,
  isLevelFilter,
  pendingNew,
  searched,
  type Decision,
  type Filters,
  type Skill,
  type SkillChange,
  type SkillDetail as Detail,
  type SkillsList,
} from './model';
import { LevelBadge, ServerChip, WritesBadge } from './parts';
import { SkillChangeList } from './SkillChangeList';
import { SkillDetail } from './SkillDetail';
import { SkillEditor, type EditorMode } from './SkillEditor';

type LoadState = { kind: 'loading' } | { kind: 'ready'; data: SkillsList } | { kind: 'error' };

function Row({ skill, onOpen }: { skill: Skill; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className={skill.available ? 'sk-tr' : 'sk-tr is-warn'} onClick={onOpen}>
      <span className="flex min-w-0 items-center gap-3">
        <span className="mc-ic">
          <SkillIcon size={14} />
        </span>
        <span className="min-w-0">
          <span className="mk-name block">
            {skill.name}
            {skill.pending ? (
              <span className="badge badge-amber ml-1.5">
                {t('skills.pendingVersion', { version: skill.pending.version })}
              </span>
            ) : null}
          </span>
          <span className="mk-meta sk-ellipsis">
            {skill.category} · {skill.description}
          </span>
        </span>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {skill.servers.map((server) => (
          <ServerChip key={server.id} server={server} />
        ))}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <LevelBadge tier={skill.data_tier} />
        <WritesBadge skill={skill} />
      </span>
      <span className="mk-meta">{skill.agents || '—'}</span>
      <span className="mk-meta mono">
        {skill.runs_30d ? skill.runs_30d.toLocaleString('es-ES') : t('skills.noData')}
      </span>
      <span className="mk-meta">
        <span className="mono">v{skill.version}</span>
        {skill.outdated_agents ? (
          <span className="text-warn">
            {t('skills.outdated', { count: skill.outdated_agents })}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function PendingRow({ change }: { change: SkillChange }) {
  const { t } = useTranslation();
  return (
    <div className="sk-tr is-pending">
      <span className="flex min-w-0 items-center gap-3">
        <span className="mc-ic">
          <SkillIcon size={14} />
        </span>
        <span className="min-w-0">
          <span className="mk-name block">
            {change.name}
            <span className="badge badge-amber ml-1.5">{t('skills.pendingFirst')}</span>
          </span>
          <span className="mk-meta block">
            {t('skills.pendingFirstMeta', {
              who: change.proposed_by_email ?? change.proposed_by,
              reason: change.reason,
            })}
          </span>
        </span>
      </span>
      <span />
      <span />
      <span className="mk-meta">—</span>
      <span className="mk-meta">—</span>
      <span className="mk-meta mono">v1</span>
    </div>
  );
}

/**
 * Construir › Skills (design skills.jsx, D92): the catalog of skills of instructions, their
 * detail, the editor of a new skill or version and the requests a different administrator
 * decides. The API authorizes every route (`ViewSkills`, `ProposeSkill`, `ApproveSkill`): what
 * is hidden here is only UX, and every text of a skill is rendered as text.
 */
export function SkillsPage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const { notify, stack } = useToasts();
  const navigate = useNavigate();
  const [routeId = ''] = (useParams()['*'] ?? '').split('/');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [forbidden, setForbidden] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [revision, setRevision] = useState(0);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<string | null>(() =>
    SKILL_ID.test(routeId) ? routeId : null,
  );
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const canEdit = me.is_admin || me.can.create_agent;

  useEffect(() => {
    const controller = new AbortController();
    api.call('getSkills', {}, { signal: controller.signal }).then(
      (data) => {
        setState({ kind: 'ready', data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 403) setForbidden(true);
        setState({ kind: 'error' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, reloadToken]);

  /** Puts a list the API answered on screen; the open panel reads its skill again. */
  const show = useCallback((data: SkillsList) => {
    setState({ kind: 'ready', data });
    setRevision((value) => value + 1);
  }, []);

  const reload = useCallback(async () => {
    show(await api.call('getSkills'));
  }, [api, show]);

  const data = state.kind === 'ready' ? state.data : null;
  const items = useMemo(() => data?.items ?? [], [data]);
  const takenIds = useMemo(
    () =>
      new Set([
        ...items.map((skill) => skill.id),
        ...(data ? pendingNew(data).map((change) => change.skill_id) : []),
      ]),
    [items, data],
  );

  const decide = useCallback(
    async (change: SkillChange, decision: Decision): Promise<boolean> => {
      const path = { change_id: change.change_id };
      try {
        const next =
          decision.kind === 'approve'
            ? await api.call('approveSkillChange', { path, body: {} })
            : decision.kind === 'reject'
              ? await api.call('rejectSkillChange', { path, body: { reason: decision.note } })
              : await api.call('withdrawSkillChange', { path, body: {} });
        show(next);
        notify(
          t(
            decision.kind === 'approve'
              ? 'skills.toast.approved'
              : decision.kind === 'reject'
                ? 'skills.toast.rejected'
                : 'skills.toast.withdrawn',
          ),
          'success',
        );
        return true;
      } catch (error) {
        const code = decisionErrorCode(error);
        notify(code ? t(`skills.changes.errors.${code}`) : t(adminErrorKey(error)), 'error');
        // The request may have changed meanwhile (decided, withdrawn, expired).
        if (error instanceof ApiError && [404, 409, 410].includes(error.status)) {
          void reload().catch(() => undefined);
        }
        return false;
      }
    },
    [api, notify, reload, show, t],
  );

  const duplicate = useCallback(
    async (detail: Detail) => {
      setDuplicating(true);
      const suffix = t('skills.detail.copySuffix');
      try {
        await api.call('postSkill', {
          body: {
            name: copyName(detail.skill.name, suffix),
            category: detail.skill.category,
            description: detail.skill.description,
            instructions: detail.instructions,
            outputs: detail.outputs,
            servers: detail.skill.servers.map((server) => server.id),
            reason: t('skills.detail.duplicateReason', {
              name: detail.skill.name,
              version: detail.skill.version,
            }),
            duplicate_of: `${detail.skill.id}@${detail.skill.version}`,
          },
        });
        notify(t('skills.toast.duplicated'), 'success');
        setSelected(null);
        void reload().catch(() => undefined);
      } catch (error) {
        const code = apiErrorCode(error);
        notify(
          code === 'skill_exists' || code === 'too_many_skills' || code === 'too_many_pending'
            ? t(`skills.editor.server.${code}`)
            : t(adminErrorKey(error)),
          'error',
        );
      } finally {
        setDuplicating(false);
      }
    },
    [api, notify, reload, t],
  );

  const crumbs = [t('skills.crumbBuild'), t('skills.title')];
  if (forbidden) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <Denied view="skills" />
        </div>
      </>
    );
  }

  const categories = data ? [...new Set(items.map((skill) => skill.category))].sort() : [];
  const base = searched(items, filters);
  const list = filtered(items, filters);
  const waiting = data ? pendingNew(data) : [];
  const detail = selected === null ? null : (items.find((skill) => skill.id === selected) ?? null);
  const patch = (changes: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...changes }));
  };
  const closeDetail = () => {
    setSelected(null);
    if (routeId) void navigate('/skills', { replace: true });
  };

  return (
    <>
      <Topbar
        crumbs={crumbs}
        actions={
          canEdit && data ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                setEditor({ kind: 'new' });
              }}
            >
              <PlusIcon size={12} />
              {t('skills.newButton')}
            </button>
          ) : null
        }
      />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('skills.title')}</h1>
          <p className="page-subtitle">{t('skills.subtitle')}</p>
        </div>
        {state.kind === 'error' ? (
          <div className="mc-body">
            <GovErrorState
              title={t('skills.loadError')}
              body={t('skills.loadErrorBody')}
              onRetry={() => {
                setState({ kind: 'loading' });
                setReloadToken((value) => value + 1);
              }}
            />
          </div>
        ) : data === null ? (
          <div
            className="card mc-table"
            role="status"
            aria-busy="true"
            aria-label={t('skills.loading')}
          >
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="sk-tr is-skel">
                <span className="flex items-center gap-3">
                  <Skel w={28} h={28} className="rounded-[7px]" />
                  <span className="grid flex-1 gap-1.5">
                    <Skel w="50%" />
                    <Skel w="80%" h={10} />
                  </span>
                </span>
                <Skel w="70%" />
                <Skel w={70} />
                <Skel w={20} />
                <Skel w={40} />
                <Skel w={30} />
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="ap-bar">
              <div className="ap-filters border-t-0">
                <div className="search-wrap max-w-[300px] flex-[1_1_220px]">
                  <SearchIcon size={13} />
                  <input
                    className="input"
                    placeholder={t('skills.search')}
                    aria-label={t('skills.searchLabel')}
                    maxLength={QUERY_MAX_LENGTH}
                    value={filters.query}
                    onChange={(event) => {
                      patch({ query: event.target.value });
                    }}
                  />
                </div>
                <div className="tk-quick" role="group" aria-label={t('skills.availabilityLabel')}>
                  {AVAILABILITY_FILTERS.map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      className={filters.availability === filter ? 'is-on' : undefined}
                      aria-pressed={filters.availability === filter}
                      onClick={() => {
                        patch({ availability: filter });
                      }}
                    >
                      {t(`skills.availability.${filter}`)}
                      <span className="mk-count">
                        {base.filter((skill) => inAvailability(skill, filter)).length}
                      </span>
                    </button>
                  ))}
                </div>
                <select
                  className="input mk-sel"
                  aria-label={t('skills.categoryLabel')}
                  value={filters.category}
                  onChange={(event) => {
                    patch({ category: event.target.value });
                  }}
                >
                  <option value="all">{t('skills.allCategories')}</option>
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
                <select
                  className="input mk-sel"
                  aria-label={t('skills.levelLabel')}
                  value={filters.level}
                  onChange={(event) => {
                    const { value } = event.target;
                    patch({ level: isLevelFilter(value) ? value : 'all' });
                  }}
                >
                  <option value="all">{t('skills.anyLevel')}</option>
                  {LEVEL_FILTERS.map((level) => (
                    <option key={level} value={level}>
                      {t(`mcpCatalog.levels.${level}`)}
                    </option>
                  ))}
                </select>
                {hasFilters(filters) ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setFilters(NO_FILTERS);
                    }}
                  >
                    {t('skills.clear')}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="mc-body">
              {list.length === 0 && (hasFilters(filters) || waiting.length === 0) ? (
                <div className="mk-empty">
                  <div className="text-sm font-semibold">
                    {items.length ? t('skills.noMatch') : t('skills.none')}
                  </div>
                  <div className="mk-meta">
                    {items.length ? t('skills.noMatchHint') : canEdit ? t('skills.noneHint') : null}
                  </div>
                </div>
              ) : (
                <div className="card mc-table">
                  <div className="sk-tr mc-th">
                    <span>{t('skills.columns.skill')}</span>
                    <span>{t('skills.columns.servers')}</span>
                    <span>{t('skills.columns.level')}</span>
                    <span>{t('skills.columns.agents')}</span>
                    <span title={t('skills.columns.runsTitle')}>{t('skills.columns.runs')}</span>
                    <span>{t('skills.columns.version')}</span>
                  </div>
                  {list.map((skill) => (
                    <Row
                      key={skill.id}
                      skill={skill}
                      onOpen={() => {
                        setSelected(skill.id);
                      }}
                    />
                  ))}
                  {hasFilters(filters)
                    ? null
                    : waiting.map((change) => (
                        <PendingRow key={change.change_id} change={change} />
                      ))}
                </div>
              )}
              {waiting.length > 0 ? (
                <SkillChangeList
                  title={t('skills.newInApproval')}
                  changes={creationChanges(data)}
                  current={null}
                  canApprove={data.can_approve}
                  onDecide={decide}
                />
              ) : null}
            </div>
          </>
        )}
      </div>
      {detail ? (
        <SkillDetail
          key={detail.id}
          skill={detail}
          revision={revision}
          canEdit={canEdit}
          canApprove={data?.can_approve ?? false}
          duplicating={duplicating}
          onClose={closeDetail}
          onNewVersion={(skill) => {
            setEditor({ kind: 'version', detail: skill });
          }}
          onDuplicate={(skill) => {
            void duplicate(skill);
          }}
          onDecide={decide}
        />
      ) : null}
      {editor && data ? (
        <SkillEditor
          mode={editor}
          categories={data.categories}
          takenIds={takenIds}
          onClose={() => {
            setEditor(null);
          }}
          onSent={(skillId) => {
            const isNew = editor.kind === 'new';
            setEditor(null);
            notify(t('skills.toast.proposed'), 'success');
            setSelected(isNew ? null : skillId);
            void reload().catch(() => undefined);
          }}
        />
      ) : null}
      {stack}
    </>
  );
}
