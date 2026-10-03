import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';

import { chatPath } from '../../agents/agents';
import { adminErrorKey } from '../../api/adminErrors';
import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { useToasts } from '../../components/admin/useToasts';
import {
  DashboardIcon,
  FilterIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
} from '../../components/icons';
import { AgentCard, type AgentItemProps } from '../../components/marketplace/AgentCard';
import { AgentDetail } from '../../components/marketplace/AgentDetail';
import { AgentTable } from '../../components/marketplace/AgentTable';
import { ListIcon } from '../../components/marketplace/icons';
import { InProgress } from '../../components/marketplace/InProgress';
import { readLayout, writeLayout } from '../../components/marketplace/layoutPreference';
import {
  builderPath,
  canManageAgent,
  categoriesOf,
  copyName,
  countByCategory,
  inTab,
  isCleaning,
  isRetired,
  matchesQuery,
  NO_MODEL_NAMES,
  shownBudget,
  sortAgents,
  SORTS,
  type Agent,
  type AgentBudget,
  type Layout,
  type MarketTab,
  type MineItem,
  type ModelNames,
  type Sort,
} from '../../components/marketplace/model';
import { RetireAgentModal } from '../../components/marketplace/RetireAgentModal';
import { Soon } from '../../components/Soon';
import { tabId } from '../../components/tabId';
import { Tabs } from '../../components/Tabs';
import { Topbar } from '../../components/Topbar';
import { useShell } from '../../layouts/ShellContext';

interface Loaded {
  agents: Agent[];
  mine: MineItem[];
  othersReview: number;
  budgets: AgentBudget[];
  modelNames: ModelNames;
}
type LoadState = { kind: 'loading' } | { kind: 'ready'; data: Loaded } | { kind: 'error' };

const ALL = 'all';
const TABS_ID = 'mk-tab';
const PANEL_ID = 'mk-panel';
const NO_AGENTS: Agent[] = [];
/**
 * While the infrastructure of a retired agent is being removed (minutes), the list is read again
 * this often so the notice of admins settles on its own.
 */
const CLEANUP_POLL_MS = 15_000;

/** A part of the page that is not for every account: skipped, or empty when it fails. */
function optional<T>(enabled: boolean, load: () => Promise<T>, fallback: T): Promise<T> {
  return enabled ? load().catch(() => fallback) : Promise.resolve(fallback);
}

/**
 * Marketplace (design marketplace.jsx): the agents the API returns for this user (published and
 * retired ones they can use), with filters, cards or list, the detail panel, «tus agentes en
 * curso», Duplicar and Retirar with a reason.
 *
 * Nothing here decides access: the list is already filtered by `UseAgent` and every action is
 * authorized by the API; `is_admin`, `can.create_agent` and `is_mine` only hide what would be
 * refused. Online status, tickets, usage order and share have no backend yet. Pinning is a
 * preference of this browser (the sidebar shows the pinned agents).
 */
function builderNoticeOf(state: unknown): 'draft_saved' | 'submitted' | null {
  if (typeof state !== 'object' || state === null || !('builderNotice' in state)) return null;
  const notice = state.builderNotice;
  return notice === 'draft_saved' || notice === 'submitted' ? notice : null;
}

export function MarketplacePage() {
  const { t } = useTranslation();
  const { api, me, reloadAgents } = useSession();
  const { pinnedAgentIds, togglePinnedAgent } = useShell();
  const navigate = useNavigate();
  const location = useLocation();
  const { notify, stack } = useToasts();
  const isAdmin = me.is_admin;
  const canCreate = me.can.create_agent;

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [tab, setTab] = useState<MarketTab>('active');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(ALL);
  const [sort, setSort] = useState<Sort>('relevance');
  const [layout, setLayoutState] = useState<Layout>(readLayout);
  const setLayout = useCallback((next: Layout) => {
    setLayoutState(next);
    writeLayout(next);
  }, []);
  // What the Agent Builder did before sending the user here (design: the toast shows on the
  // Marketplace). The router state is ours, but it is still read as one of two known values.
  const builderNotice = builderNoticeOf(location.state);
  const noticeShownFor = useRef<string | null>(null);
  useEffect(() => {
    // Once per navigation, also when the effect runs twice (StrictMode in development).
    if (builderNotice === null || noticeShownFor.current === location.key) return;
    noticeShownFor.current = location.key;
    if (builderNotice === 'submitted') notify(t('agentBuilder.toasts.submitted'), 'info');
    else notify(t('agentBuilder.toasts.draftSaved'));
    // Shown once: a reload or going back does not repeat it.
    void navigate('.', { replace: true, state: null });
  }, [builderNotice, location.key, navigate, notify, t]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<Agent | null>(null);
  const [cloningId, setCloningId] = useState<string | null>(null);
  const retireLock = useRef<Promise<number | null> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Independent requests go out together; only the agent list is required.
    Promise.all([
      api.call('getAgents'),
      optional(canCreate, () => api.call('getMine').then((mine) => mine.items), []),
      optional(
        isAdmin,
        () =>
          api
            .call('getReviews')
            .then((reviews) => reviews.queue.filter((review) => !review.is_author).length),
        0,
      ),
      optional(isAdmin, () => api.call('getBudgets').then((budgets) => budgets.agents), []),
      // Design: model names only for creators and admins (the catalog is theirs to read); the
      // rest, and anyone when it does not answer, see the identifier.
      optional(
        canCreate || isAdmin,
        () =>
          api
            .call('getModels')
            .then((models): ModelNames => new Map(models.items.map((m) => [m.id, m.name]))),
        NO_MODEL_NAMES,
      ),
    ]).then(
      ([agents, mine, othersReview, budgets, modelNames]) => {
        if (cancelled) return;
        setState({
          kind: 'ready',
          data: { agents: agents.items, mine, othersReview, budgets, modelNames },
        });
      },
      () => {
        if (!cancelled) setState({ kind: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, canCreate, isAdmin, reloadToken]);

  const data = state.kind === 'ready' ? state.data : null;
  const cleaning = data?.agents.some(isCleaning) ?? false;

  // The deprovisioner finishes on its own: keep reading the agents until nothing is being removed.
  useEffect(() => {
    if (!cleaning) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      api.call('getAgents', {}, { signal: controller.signal }).then(
        (agents) => {
          if (controller.signal.aborted) return;
          setState((current) =>
            current.kind === 'ready'
              ? { kind: 'ready', data: { ...current.data, agents: agents.items } }
              : current,
          );
        },
        () => undefined,
      );
    }, CLEANUP_POLL_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [api, cleaning]);
  const budgets = useMemo(
    () => new Map((data?.budgets ?? []).map((budget) => [budget.agent_id, budget])),
    [data?.budgets],
  );

  const modelNames = data?.modelNames ?? NO_MODEL_NAMES;

  const pinnedSet = useMemo(() => new Set(pinnedAgentIds), [pinnedAgentIds]);
  const togglePin = useCallback(
    (agent: Agent) => {
      togglePinnedAgent(agent.id);
    },
    [togglePinnedAgent],
  );
  const openChat = useCallback(
    (agent: Agent) => {
      void navigate(chatPath(agent.id));
    },
    [navigate],
  );
  const editAgent = useCallback(
    (agent: Agent) => {
      void navigate(builderPath.version(agent.id, agent.version));
    },
    [navigate],
  );
  const openDetail = useCallback((agent: Agent) => {
    setDetailId(agent.id);
  }, []);

  /** Design `clone`: a new draft with the published content, opened in the Agent Builder. */
  const cloneAgent = useCallback(
    async (agent: Agent) => {
      setCloningId(agent.id);
      try {
        const source = await api.call('readVersion', {
          path: { agent_id: agent.id, version: agent.version },
        });
        const copy = await api.call('postAgent', {
          body: {
            definition: {
              ...source.definition,
              name: copyName(source.definition.name, t('marketplace.clone.suffix')),
            },
          },
        });
        // Design: the Builder says it is a copy (a notice that stays), instead of a toast here.
        void navigate(builderPath.version(copy.agent_id, copy.version), {
          state: { clonedFrom: source.definition.name },
        });
      } catch (error) {
        const tooMany = error instanceof ApiError && error.code === 'too_many_drafts';
        notify(tooMany ? t('marketplace.clone.tooManyDrafts') : t(adminErrorKey(error)), 'error');
      } finally {
        setCloningId(null);
      }
    },
    [api, navigate, notify, t],
  );

  /**
   * The list does not carry the optimistic lock: it is read from the detail when the dialog
   * opens, so a change made while the admin writes the reason is refused (409).
   */
  const readLock = useCallback(
    (agent: Agent) => {
      const lock = api
        .call('getAgent', { path: { agent_id: agent.id } })
        .then((detail) => detail.lock_version);
      // A failure is reported when the dialog is submitted.
      lock.catch(() => undefined);
      return lock;
    },
    [api],
  );
  const startRetire = useCallback(
    (agent: Agent) => {
      retireLock.current = readLock(agent);
      setRetiring(agent);
    },
    [readLock],
  );

  const retireAgent = async (agent: Agent, reason: string): Promise<string | null> => {
    try {
      const lockVersion = await (retireLock.current ?? readLock(agent));
      if (lockVersion === null) return t('admin.errors.generic');
      const retired = await api.call('retireAgent', {
        path: { agent_id: agent.id },
        body: { lock_version: lockVersion, reason },
      });
      setState((current) =>
        current.kind === 'ready'
          ? {
              kind: 'ready',
              data: {
                ...current.data,
                agents: current.data.agents.map((item) =>
                  item.id === retired.id ? retired : item,
                ),
              },
            }
          : current,
      );
      setRetiring(null);
      // The sidebar, the chat and the agent picker stop offering it.
      reloadAgents();
      notify(t('marketplace.retire.done', { name: agent.name }));
      return null;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        return t('marketplace.retire.conflict');
      }
      // The lock could not be read, or the request failed: the next attempt reads it again.
      retireLock.current = null;
      return t(adminErrorKey(error));
    }
  };

  const itemProps = useCallback(
    (agent: Agent): AgentItemProps => ({
      agent,
      budget: shownBudget(agent, budgets),
      canManage: canManageAgent(agent, { isAdmin, canCreate }),
      isAdmin,
      modelNames,
      cloning: cloningId === agent.id,
      pinned: pinnedSet.has(agent.id),
      onTogglePin: togglePin,
      onOpen: openDetail,
      onChat: openChat,
      onEdit: editAgent,
      onClone: (target) => void cloneAgent(target),
      onRetire: startRetire,
    }),
    [
      budgets,
      canCreate,
      isAdmin,
      modelNames,
      cloningId,
      pinnedSet,
      togglePin,
      openDetail,
      openChat,
      editAgent,
      cloneAgent,
      startRetire,
    ],
  );

  const crumbs = [t('marketplace.crumb')];
  const actions = canCreate ? (
    <Link className="btn btn-sm btn-primary" to={builderPath.create}>
      <PlusIcon size={12} /> {t('marketplace.newAgent')}
    </Link>
  ) : undefined;

  // Design: the bar stays while the agents load or fail; only the body changes.
  const agents = data?.agents ?? NO_AGENTS;
  const pool = inTab(agents, tab);
  const matching = pool.filter((agent) => matchesQuery(agent, query));
  const categoryCounts = countByCategory(matching);
  const categories = categoriesOf(agents);
  const list = sortAgents(
    category === ALL ? matching : matching.filter((agent) => agent.category === category),
    sort,
    budgets,
  );
  const anyFilter = query.trim() !== '' || category !== ALL;
  // Grouped by category, as long as every agent has one (it is optional in the API).
  const grouped =
    layout === 'cards' &&
    tab === 'active' &&
    sort === 'relevance' &&
    !anyFilter &&
    list.every((agent) => agent.category);
  // Design `pinnedList`: its own group on top, while nothing is filtered.
  const pinnedList =
    tab === 'active' && !anyFilter ? pool.filter((agent) => pinnedSet.has(agent.id)) : [];
  const archivedCount = agents.filter(isRetired).length;
  const detail = detailId ? agents.find((agent) => agent.id === detailId) : undefined;
  const mine = data?.mine ?? [];
  const othersReview = data?.othersReview ?? 0;
  const showInProgress = tab === 'active' && !anyFilter && (mine.length > 0 || othersReview > 0);
  const sortLabel = (key: Sort) => t(`marketplace.filters.sorts.${key}`);
  // Usage has no data yet. Spend only reaches admins; for everyone else it orders by name.
  const sortAvailable = (key: Sort) => key !== 'usage';
  const clearFilters = () => {
    setQuery('');
    setCategory(ALL);
  };

  return (
    <>
      <Topbar crumbs={crumbs} actions={actions} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('marketplace.title')}</h1>
          {data ? (
            <p className="page-subtitle">
              {t(
                tab === 'archived' ? 'marketplace.subtitleArchived' : 'marketplace.subtitleActive',
                { count: pool.length },
              )}
            </p>
          ) : null}
        </div>

        <div className="mk-bar">
          <Tabs
            label={t('marketplace.tabs.label')}
            tabs={[
              { id: 'active', label: t('marketplace.tabs.active') },
              {
                id: 'archived',
                label: t('marketplace.tabs.archived'),
                count: archivedCount > 0 ? archivedCount : null,
              },
            ]}
            active={tab}
            onChange={setTab}
            idPrefix={TABS_ID}
            panelId={PANEL_ID}
          />
          <div className="mk-filters">
            <div className="search-wrap mk-search">
              <SearchIcon size={13} />
              <input
                className="input"
                type="search"
                placeholder={t('marketplace.filters.searchPlaceholder')}
                aria-label={t('marketplace.filters.search')}
                value={query}
                maxLength={100}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
            </div>
            <select
              className="input mk-sel"
              aria-label={t('marketplace.filters.category')}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
              }}
            >
              <option value={ALL}>{t('marketplace.filters.allCategories')}</option>
              {categories.map((item) => (
                <option key={item} value={item}>
                  {t('marketplace.filters.categoryOption', {
                    category: item,
                    count: categoryCounts.get(item) ?? 0,
                  })}
                </option>
              ))}
            </select>
            <Soon name={t('soon.item', { label: t('marketplace.filters.status') })}>
              <select className="input mk-sel" tabIndex={-1} defaultValue={ALL}>
                <option value={ALL}>{t('marketplace.filters.anyStatus')}</option>
              </select>
            </Soon>
            <Soon name={t('soon.item', { label: t('marketplace.filters.more') })}>
              <button type="button" className="btn btn-sm" tabIndex={-1}>
                <FilterIcon size={12} /> {t('marketplace.filters.more')}
              </button>
            </Soon>
            <div className="mk-spacer" />
            <select
              className="input mk-sel"
              aria-label={t('marketplace.filters.sort')}
              value={sort}
              onChange={(event) => {
                const next = SORTS.find((key) => key === event.target.value);
                if (next && sortAvailable(next)) setSort(next);
              }}
            >
              {SORTS.map((key) => (
                <option key={key} value={key} disabled={!sortAvailable(key)}>
                  {t(
                    sortAvailable(key)
                      ? 'marketplace.filters.sortOption'
                      : 'marketplace.filters.sortSoon',
                    { label: sortLabel(key) },
                  )}
                </option>
              ))}
            </select>
            <div className="mk-seg" role="group" aria-label={t('marketplace.filters.layout')}>
              <button
                type="button"
                className={layout === 'cards' ? 'is-on' : undefined}
                aria-pressed={layout === 'cards'}
                aria-label={t('marketplace.filters.cards')}
                title={t('marketplace.filters.cards')}
                onClick={() => {
                  setLayout('cards');
                }}
              >
                <DashboardIcon size={13} />
              </button>
              <button
                type="button"
                className={layout === 'list' ? 'is-on' : undefined}
                aria-pressed={layout === 'list'}
                aria-label={t('marketplace.filters.list')}
                title={t('marketplace.filters.list')}
                onClick={() => {
                  setLayout('list');
                }}
              >
                <ListIcon size={13} />
              </button>
            </div>
          </div>
        </div>

        <div
          className="mk-body"
          id={PANEL_ID}
          role="tabpanel"
          aria-labelledby={tabId(TABS_ID, tab)}
        >
          {showInProgress ? <InProgress mine={mine} othersReview={othersReview} /> : null}
          {state.kind === 'loading' ? (
            <div className="mk-empty" role="status">
              <span className="g-spin" aria-hidden="true" />
              <div className="mk-meta">{t('marketplace.loading')}</div>
            </div>
          ) : state.kind === 'error' ? (
            <div className="mk-empty" role="alert">
              <div className="text-[14px] font-semibold text-strong">
                {t('marketplace.loadError')}
              </div>
              <div className="mk-meta">{t('marketplace.loadErrorHint')}</div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setState({ kind: 'loading' });
                  setReloadToken((value) => value + 1);
                }}
              >
                <RefreshIcon size={12} /> {t('common.retry')}
              </button>
            </div>
          ) : list.length === 0 ? (
            <div className="mk-empty">
              <div className="text-[14px] font-semibold text-strong">
                {tab === 'archived' && !anyFilter
                  ? t('marketplace.empty.archivedTitle')
                  : t('marketplace.empty.noMatchTitle')}
              </div>
              <div className="text-[13px] text-muted">
                {tab === 'archived' && !anyFilter
                  ? t('marketplace.empty.archivedBody')
                  : t('marketplace.empty.noMatchBody')}
              </div>
              {anyFilter ? (
                <button type="button" className="btn btn-sm" onClick={clearFilters}>
                  {t('marketplace.filters.clear')}
                </button>
              ) : null}
            </div>
          ) : layout === 'list' ? (
            <AgentTable agents={list} itemProps={itemProps} />
          ) : grouped ? (
            <>
              {pinnedList.length > 0 ? (
                <section className="mk-group">
                  <h2 className="mk-group-h">
                    {t('marketplace.pin.group').toLowerCase()} <span>{pinnedList.length}</span>
                  </h2>
                  <div className="mk-grid">
                    {pinnedList.map((agent) => (
                      <AgentCard key={agent.id} {...itemProps(agent)} />
                    ))}
                  </div>
                </section>
              ) : null}
              {categoriesOf(list).map((item) => {
                // Design: a pinned agent shows once, in its own group, while that group is shown.
                const group = list.filter(
                  (agent) =>
                    agent.category === item && !(pinnedList.length > 0 && pinnedSet.has(agent.id)),
                );
                if (group.length === 0) return null;
                return (
                  <section key={item} className="mk-group">
                    <h2 className="mk-group-h">
                      {item.toLowerCase()} <span>{group.length}</span>
                    </h2>
                    <div className="mk-grid">
                      {group.map((agent) => (
                        <AgentCard key={agent.id} {...itemProps(agent)} />
                      ))}
                    </div>
                  </section>
                );
              })}
            </>
          ) : (
            <div className="mk-grid">
              {list.map((agent) => (
                <AgentCard key={agent.id} {...itemProps(agent)} />
              ))}
            </div>
          )}
        </div>
      </div>
      {detail ? (
        <AgentDetail
          {...itemProps(detail)}
          agents={agents}
          onClose={() => {
            setDetailId(null);
          }}
        />
      ) : null}
      {retiring ? (
        <RetireAgentModal
          name={retiring.name}
          onRetire={(reason) => retireAgent(retiring, reason)}
          onClose={() => {
            setRetiring(null);
          }}
        />
      ) : null}
      {stack}
    </>
  );
}
