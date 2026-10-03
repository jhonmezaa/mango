import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { GovErrorState, Skel } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import { Badge } from '../../components/Badge';
import {
  BotIcon,
  Check2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InfoIcon,
  SearchIcon,
} from '../../components/icons';
import { tabId } from '../../components/tabId';
import { Tabs } from '../../components/Tabs';
import { Topbar } from '../../components/Topbar';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { formatRelative } from '../../lib/format';
import { ApprovalBody } from './ApprovalBody';
import { ApprovalDecision } from './ApprovalDecision';
import {
  NO_FILTERS,
  QUERY_MAX_LENGTH,
  QUICK,
  STATUS_TONE,
  agentsOf,
  baseFilter,
  canExpire,
  hasFilters,
  isReadyForMe,
  isWaiting,
  leftText,
  matchesQuick,
  minutesLeft,
  personOf,
  replaceApproval,
  shortId,
  sortApprovals,
  type Approval,
  type ApprovalList,
  type Filters,
} from './model';
import { PoliciesPanel } from './PoliciesPanel';

type Tab = 'pending' | 'resolved' | 'policies';
type ListView = Exclude<Tab, 'policies'>;
type LoadState =
  { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; view: ListView; list: ApprovalList };

const PANEL_ID = 'approvals-panel';
/** Design: under this width the list takes the whole page and the detail opens over it. */
const NARROW_QUERY = '(max-width: 1180px)';
const SKELETON_ROWS = [0, 1, 2] as const;
/** Someone else may sign or reject while the list is open: it is read again this often. */
const POLL_MS = 20_000;
/** "Vence en…" labels move on their own. */
const CLOCK_MS = 30_000;
const TABS: readonly Tab[] = ['pending', 'resolved', 'policies'];
const APPROVAL_ID = /^[0-9a-f]{32}$/;

function isTab(value: string): value is Tab {
  return (TABS as readonly string[]).includes(value);
}

function ApprovalRow({
  approval,
  active,
  narrow,
  now,
  onSelect,
}: {
  approval: Approval;
  active: boolean;
  narrow: boolean;
  now: number;
  onSelect: (approval: Approval) => void;
}) {
  const { t } = useTranslation();
  const waiting = isWaiting(approval);
  const left = canExpire(approval) ? minutesLeft(approval, now) : null;
  const ready = isReadyForMe(approval);
  const status = t(`approvals.status.${approval.status}`);
  const classes = ['card', 'ap-row'];
  if (active) classes.push('is-active');
  if (approval.status === 'expired') classes.push('is-expired');
  const dot = ready
    ? t('approvals.row.readyYou')
    : approval.can_sign
      ? t('approvals.row.waitingYou')
      : null;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={classes.join(' ')}
      onClick={() => {
        onSelect(approval);
      }}
    >
      <span className="mk-avatar sm is-neutral">
        <BotIcon size={14} />
      </span>
      <span className="ap-row-main">
        <span className="ap-row-t">{approval.description || approval.tool}</span>
        <span className="ap-row-s">
          <span className="mono">{t('approvals.id', { id: shortId(approval) })}</span>
          {' · '}
          {approval.agent_name ?? approval.agent_id}
          {' · '}
          {t('approvals.row.requested', {
            who: personOf(approval.requested_by_email, approval.requested_by),
          })}
          {' · '}
          {formatRelative(approval.created_at, now)}
        </span>
        <span className="ap-row-badges">
          {waiting && approval.approvals_needed > 1 ? (
            <Badge>
              {t('approvals.row.signatures', {
                given: approval.signatures.length,
                needed: approval.approvals_needed,
              })}
            </Badge>
          ) : null}
          {!waiting ? <Badge tone={STATUS_TONE[approval.status]}>{status}</Badge> : null}
          {left === null ? null : left <= 0 ? (
            <Badge>{t('approvals.row.expired')}</Badge>
          ) : (
            <Badge tone={left < 60 ? 'red' : 'neutral'}>{leftText(t, approval, now)}</Badge>
          )}
        </span>
      </span>
      {dot ? <span className="ap-dot" role="img" title={dot} aria-label={dot} /> : null}
      {narrow ? <ChevronRightIcon size={14} className="ap-row-go" /> : null}
    </button>
  );
}

/**
 * Aprobaciones (design approvals.jsx): the write tool calls that wait for a person, the ones
 * already decided and the policy of each write tool (D27). Approvers see the requests that need
 * approvers; everyone else sees what they asked for. The API authorizes every action and decides
 * what each account sees: nothing here does.
 */
export function ApprovalsPage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const { notify, stack } = useToasts();
  const navigate = useNavigate();
  const narrow = useMediaQuery(NARROW_QUERY);
  // Deep link `/approvals/<tab>/<id>`: untrusted input, only well-formed values are used.
  const [routeTab = '', routeId = ''] = (useParams()['*'] ?? '').split('/');
  const tab: Tab = isTab(routeTab) ? routeTab : 'pending';
  const linked = APPROVAL_ID.test(routeId) ? routeId : null;
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [now, setNow] = useState(() => Date.now());
  const [reloadToken, setReloadToken] = useState(0);
  const view: ListView | null = tab === 'policies' ? null : tab;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, CLOCK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (view === null) return undefined;
    const controller = new AbortController();
    const load = (first: boolean) => {
      api.call('listApprovals', { query: { view } }, { signal: controller.signal }).then(
        (list) => {
          if (!controller.signal.aborted) setState({ kind: 'ready', view, list });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          // A failed refresh keeps what is on screen; only the first load shows the error.
          if (first || (error instanceof ApiError && error.status === 403)) {
            setState({ kind: 'error' });
          }
        },
      );
    };
    load(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') load(false);
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [api, view, reloadToken]);

  const ready = state.kind === 'ready' && state.view === view ? state.list : null;
  const items = useMemo(() => ready?.items ?? [], [ready]);
  const canDecide = ready?.can_decide ?? false;
  const base = useMemo(() => baseFilter(items, filters), [items, filters]);
  const list = useMemo(
    () =>
      view === null
        ? []
        : sortApprovals(
            base.filter((item) => matchesQuick(item, filters.quick, now)),
            view,
          ),
    [base, filters.quick, now, view],
  );
  const agents = useMemo(() => agentsOf(items), [items]);

  const go = useCallback(
    (nextTab: Tab, id?: string) => {
      const path = id ? `/approvals/${nextTab}/${encodeURIComponent(id)}` : `/approvals/${nextTab}`;
      void navigate(path, { replace: true });
    },
    [navigate],
  );
  const select = useCallback(
    (approval: Approval) => {
      if (view) go(view, approval.approval_id);
    },
    [go, view],
  );
  const onUpdated = useCallback((next: Approval) => {
    setState((current) =>
      current.kind === 'ready'
        ? {
            ...current,
            list: { ...current.list, items: replaceApproval(current.list.items, next) },
          }
        : current,
    );
  }, []);
  const patch = (changes: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...changes }));
  };

  // Design: on a wide screen the first request is open unless another one was chosen.
  const chosen = list.find((item) => item.approval_id === linked) ?? null;
  const selected = chosen ?? (narrow ? null : (list[0] ?? null));
  const showDetail = narrow && chosen !== null;
  const filtered = hasFilters(filters);

  // Listbox keyboard: the arrows and J/K move the selection (design).
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const down = event.key === 'ArrowDown' || event.key === 'j';
    const up = event.key === 'ArrowUp' || event.key === 'k';
    if (!down && !up) return;
    const index = selected ? list.indexOf(selected) : -1;
    const next = list[index + (down ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    select(next);
    const options = event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]');
    options[list.indexOf(next)]?.focus();
  };

  const crumbs = [t('approvals.crumbGov'), t('approvals.title')];
  const pendingCount =
    state.kind === 'ready' && state.view === 'pending' ? state.list.items.length : null;

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="content">
        {showDetail ? null : (
          <>
            <div className="page-head">
              <h1 className="page-title">{t('approvals.title')}</h1>
              <p className="page-subtitle">{t('approvals.subtitle')}</p>
            </div>
            <div className="ap-bar">
              <Tabs
                label={t('approvals.tabsLabel')}
                idPrefix="approvals"
                panelId={PANEL_ID}
                active={tab}
                onChange={(next) => {
                  setFilters(NO_FILTERS);
                  if (next !== 'policies' && next !== view) setState({ kind: 'loading' });
                  go(next);
                }}
                tabs={[
                  {
                    id: 'pending',
                    label: t('approvals.tabs.pending'),
                    count: pendingCount && pendingCount > 0 ? pendingCount : null,
                  },
                  { id: 'resolved', label: t('approvals.tabs.resolved') },
                  { id: 'policies', label: t('approvals.tabs.policies') },
                ]}
              />
              {view !== null ? (
                <div className="ap-filters">
                  <div className="search-wrap max-w-[260px] flex-[1_1_200px]">
                    <SearchIcon size={13} />
                    <input
                      className="input"
                      placeholder={t('approvals.search')}
                      aria-label={t('approvals.searchLabel')}
                      maxLength={QUERY_MAX_LENGTH}
                      value={filters.query}
                      onChange={(event) => {
                        patch({ query: event.target.value });
                      }}
                    />
                  </div>
                  {view === 'pending' ? (
                    <div className="tk-quick" role="group" aria-label={t('approvals.quickLabel')}>
                      {QUICK.map((quick) => (
                        <button
                          key={quick}
                          type="button"
                          className={filters.quick === quick ? 'is-on' : undefined}
                          aria-pressed={filters.quick === quick}
                          onClick={() => {
                            patch({ quick });
                          }}
                        >
                          {t(`approvals.quick.${quick}`)}
                          <span className="mk-count">
                            {base.filter((item) => matchesQuick(item, quick, now)).length}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <select
                    className="input mk-sel"
                    aria-label={t('approvals.agentLabel')}
                    value={filters.agent}
                    onChange={(event) => {
                      patch({ agent: event.target.value });
                    }}
                  >
                    <option value="all">{t('approvals.anyAgent')}</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                  {filtered ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setFilters(NO_FILTERS);
                      }}
                    >
                      {t('approvals.clear')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        )}
        <div id={PANEL_ID} role="tabpanel" aria-labelledby={tabId('approvals', tab)}>
          {view === null ? (
            <PoliciesPanel api={api} me={me} notify={notify} />
          ) : state.kind === 'error' ? (
            <div className="ap-body" role="alert">
              <GovErrorState
                title={t('approvals.loadErrorTitle')}
                body={t('approvals.loadErrorBody')}
                onRetry={() => {
                  setState({ kind: 'loading' });
                  setReloadToken((value) => value + 1);
                }}
              />
            </div>
          ) : ready === null ? (
            <div className="ap-body" role="status" aria-label={t('approvals.loading')}>
              <div className="ap-list">
                {SKELETON_ROWS.map((row) => (
                  <div key={row} className="card ap-row ap-row-skel">
                    <Skel w="55%" h={13} />
                    <Skel w="80%" h={11} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              {!canDecide && !showDetail ? (
                <div className="ap-note">
                  <InfoIcon size={13} /> {t('approvals.ownNote')}
                </div>
              ) : null}
              {list.length === 0 ? (
                <div className="ap-body">
                  <div className="mk-empty" role="status">
                    <Check2Icon size={22} className="ap-empty-i" />
                    <div className="ap-empty-t">
                      {filtered
                        ? t('approvals.empty.filteredTitle')
                        : t(`approvals.empty.${view}Title`)}
                    </div>
                    <div className="mk-meta">
                      {filtered
                        ? t('approvals.empty.filteredBody')
                        : t(`approvals.empty.${view}Body`)}
                    </div>
                    {filtered ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setFilters(NO_FILTERS);
                        }}
                      >
                        {t('approvals.clearFilters')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div
                  className={
                    narrow ? (showDetail ? 'ap-body show-detail' : 'ap-body') : 'ap-body is-split'
                  }
                >
                  {showDetail ? null : (
                    <div>
                      <div
                        className="ap-list"
                        role="listbox"
                        aria-label={t('approvals.queueLabel')}
                        onKeyDown={onListKey}
                      >
                        {list.map((item) => (
                          <ApprovalRow
                            key={item.approval_id}
                            approval={item}
                            active={!narrow && item === selected}
                            narrow={narrow}
                            now={now}
                            onSelect={select}
                          />
                        ))}
                      </div>
                      {list.length > 1 ? (
                        <div className="ap-hint">
                          <kbd>J</kbd>
                          <kbd>K</kbd> {t('approvals.keysHint')}
                        </div>
                      ) : null}
                    </div>
                  )}
                  {!narrow || showDetail ? (
                    <section className="ap-detail card" aria-label={t('approvals.detail.label')}>
                      {selected ? (
                        <>
                          {narrow ? (
                            <button
                              type="button"
                              className="ap-back"
                              onClick={() => {
                                go(view);
                              }}
                            >
                              <ChevronLeftIcon size={13} /> {t('approvals.back')}
                            </button>
                          ) : null}
                          <div className="ap-detail-h">
                            <span className="mono ap-detail-id">
                              {t('approvals.id', { id: shortId(selected) })}
                            </span>
                            <Badge tone={STATUS_TONE[selected.status]}>
                              {t(`approvals.status.${selected.status}`)}
                            </Badge>
                          </div>
                          <div className="ap-detail-b">
                            <ApprovalBody approval={selected} me={me} now={now} />
                          </div>
                          <div className="ap-detail-f">
                            <ApprovalDecision
                              key={selected.approval_id}
                              api={api}
                              me={me}
                              approval={selected}
                              canDecide={canDecide}
                              now={now}
                              onUpdated={onUpdated}
                              notify={notify}
                            />
                          </div>
                        </>
                      ) : (
                        <div className="mk-empty">
                          <div className="mk-meta">{t('approvals.selectOne')}</div>
                        </div>
                      )}
                    </section>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {stack}
    </>
  );
}
