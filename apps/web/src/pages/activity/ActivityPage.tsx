import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { Denied, GovErrorState, Skel } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import {
  ArrowRightIcon,
  DownloadIcon,
  LockIcon,
  MoneyIcon,
  PlayIcon,
  SearchIcon,
  TerminalIcon,
  WarnIcon,
  X2Icon,
  type IconProps,
} from '../../components/icons';
import { agentIconStyle } from '../../components/marketplace/agentIcons';
import { Topbar } from '../../components/Topbar';
import { canView } from '../../layouts/navigation';
import { formatDuration } from '../../lib/format';
import {
  CAP,
  KINDS,
  LIVE_LOOKBACK_MS,
  LIVE_MS,
  PAGE,
  RANGES,
  approvalState,
  groupByHour,
  hourLabel,
  inRange,
  linkOf,
  matches,
  merge,
  statsOf,
  subOf,
  timeOf,
  toCsv,
  type ActivityAgent,
  type ActivityEvent,
  type ActivityPage as Page,
  type Kind,
  type Range,
} from './model';

type LoadState =
  { kind: 'loading' } | { kind: 'error'; forbidden: boolean } | { kind: 'ready'; page: Page };

const KIND_ICON: Record<Kind, ComponentType<IconProps>> = {
  tool: TerminalIcon,
  approval: LockIcon,
  budget: MoneyIcon,
  error: X2Icon,
};
/** Design round 20: the widths of the loading rows and of «agentes más activos». */
const SKELETON_ROWS = ['62%', '48%', '70%', '55%', '66%', '44%'] as const;
const SKELETON_AGENTS = ['70%', '52%', '60%'] as const;
const KPI_KEYS = ['events', 'agents', 'errors', 'latency'] as const;

function AgentMark({ agent }: { agent: ActivityAgent | undefined }) {
  const { Icon, colorClass } = agentIconStyle(agent?.icon ?? 'Bot', agent?.color ?? 0);
  return (
    <span className={`tk-agent-ic ac-ic ${colorClass}`}>
      <Icon size={12} />
    </span>
  );
}

/** Design round 20: the skeleton of the list and of «agentes más activos». */
function Loading() {
  const { t } = useTranslation();
  return (
    <div className="ac-grid" role="status" aria-label={t('activity.loading')}>
      <div>
        <div className="au-day-h">
          <Skel w={92} h={10} />
        </div>
        <div className="card ac-card">
          {SKELETON_ROWS.map((width) => (
            <div key={width} className="ac-row">
              <div className="ac-main ac-skel">
                <Skel w={34} h={10} />
                <Skel w={24} h={24} className="ac-skel-ic" />
                <span className="ac-skel-lines">
                  <Skel w={width} />
                </span>
                <Skel w={40} h={10} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <aside className="ac-side">
        <div className="card ac-card">
          <div className="ac-side-h">{t('activity.mostActive')}</div>
          {SKELETON_AGENTS.map((width) => (
            <div key={width} className="ac-ag ac-skel-ag">
              <Skel w={width} />
              <Skel h={4} className="ac-skel-bar" />
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

/** Design round 20: the four indicators while the activity loads. */
function LoadingKpis({ range }: { range: string }) {
  const { t } = useTranslation();
  return (
    <div className="bg-kpis" aria-hidden="true">
      {KPI_KEYS.map((key) => (
        <div key={key} className="card bg-kpi">
          <span className="bg-kpi-l">{t(`activity.kpi.${key}`, { range })}</span>
          <Skel w={64} h={22} />
          <Skel w="62%" h={10} />
        </div>
      ))}
    </div>
  );
}

/** The right of a row (design round 20 `slotOf`): an approval's state, «error» or the latency. */
function Slot({ event }: { event: ActivityEvent }) {
  const { t } = useTranslation();
  if (event.kind === 'approval') {
    const state = approvalState(event);
    return state ? (
      <span className={`mono ac-ms is-${state}`}>{t(`activity.approval.${state}`)}</span>
    ) : null;
  }
  if (event.ok === false) return <span className="mono ac-ms is-err">{t('activity.error')}</span>;
  return event.ms !== null ? <span className="mono ac-ms">{formatDuration(event.ms)}</span> : null;
}

/**
 * Actividad (design activity.jsx, rounds 19 and 20 «Disponible hoy», D90): tool calls with their result
 * and latency, the approvals agents asked for and the turns an agent's budget blocked, from
 * GET /api/activity. Everyone sees their own activity; an administrator sees everyone's (the API
 * decides: `scope`), and of someone else's event only the agent, the tool, the result and the
 * time. «En vivo» asks every 15 s while the tab is visible. Every value is rendered as text.
 */
export function ActivityPage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const navigate = useNavigate();
  const { notify, stack } = useToasts();
  const [range, setRange] = useState<Range>('24h');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [now, setNow] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [live, setLive] = useState(true);
  // Design round 20: a live poll that failed says so in the toolbar; the list stays.
  const [pollFailed, setPollFailed] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [agentFilter, setAgentFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  // What the live mode compares against, without restarting its timer on every change.
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    const controller = new AbortController();
    api.call('getActivity', { query: { range } }, { signal: controller.signal }).then(
      (page) => {
        setEvents(page.events);
        setNow(Date.now());
        setFresh(new Set());
        setPollFailed(false);
        setState({ kind: 'ready', page });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', forbidden: error instanceof ApiError && error.status === 403 });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, range, reloadToken]);

  const ready = state.kind === 'ready';
  // Design round 19: every 15 s, paused while the tab is hidden, at once when it comes back.
  useEffect(() => {
    if (!live || !ready) return;
    const controller = new AbortController();
    const poll = () => {
      const since = new Date(Date.now() - LIVE_LOOKBACK_MS).toISOString();
      api.call('getActivity', { query: { range, since } }, { signal: controller.signal }).then(
        (page) => {
          const before = new Set(eventsRef.current.map((event) => event.id));
          const added = page.events.filter((event) => !before.has(event.id));
          setNow(Date.now());
          setPollFailed(false);
          if (!added.length) return;
          setEvents((current) => merge(current, added));
          setFresh(new Set(added.map((event) => event.id)));
        },
        () => {
          // The list stays; the next poll tries again (design round 20).
          if (!controller.signal.aborted) setPollFailed(true);
        },
      );
    };
    let timer: number | null = null;
    const start = () => {
      if (timer === null && !document.hidden) timer = window.setInterval(poll, LIVE_MS);
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        poll();
        start();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      controller.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api, live, ready, range]);

  const page = state.kind === 'ready' ? state.page : null;
  // Design round 20: «En vivo» and «Exportar CSV» are off while loading, on error and without access.
  const blocked = page === null;
  const capped = page?.truncated === true;
  const everyone = page?.scope === 'all';
  const agents = useMemo(() => page?.agents ?? [], [page]);
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const nameOf = useCallback((id: string) => agentById.get(id)?.name ?? id, [agentById]);
  const textOf = useCallback((event: ActivityEvent) => t(`activity.text.${event.kind}`), [t]);

  const period = useMemo(() => inRange(events, range, now), [events, range, now]);
  const needle = query.trim().toLowerCase();
  const base = useMemo(
    () =>
      period.filter(
        (event) =>
          (agentFilter === 'all' || event.agent_id === agentFilter) &&
          matches(event, needle, `${nameOf(event.agent_id)} ${textOf(event)}`),
      ),
    [period, agentFilter, needle, nameOf, textOf],
  );
  const rows = useMemo(
    () => (kind === 'all' ? base : base.filter((event) => event.kind === kind)),
    [base, kind],
  );
  const stats = useMemo(() => statsOf(period), [period]);
  const published = agents.filter((agent) => agent.published);
  const silent = everyone
    ? published.filter((agent) => !stats.byAgent.some((line) => line.id === agent.id))
    : [];
  const agentOptions = agents.filter((agent) =>
    events.some((event) => event.agent_id === agent.id),
  );
  const anyFilter = kind !== 'all' || agentFilter !== 'all' || needle !== '';
  const canSeeBudgets = canView(me, 'budgets');
  const maxN = stats.byAgent[0]?.n ?? 1;
  const shown = rows.slice(0, limit);
  const groups = groupByHour(shown);
  const rangeLabel = t(`activity.ranges.${range}`);

  const clear = () => {
    setKind('all');
    setAgentFilter('all');
    setQuery('');
  };
  const retry = () => {
    setState({ kind: 'loading' });
    setReloadToken((value) => value + 1);
  };
  // Design round 20: the «resultado» column says the state of an approval and «bloqueado».
  const resultOf = (event: ActivityEvent) => {
    if (event.kind === 'approval') {
      const state = approvalState(event);
      return state ? t(`activity.approval.${state}`) : '';
    }
    if (event.kind === 'budget') return t('activity.blocked');
    return event.ok === false ? 'error' : 'ok';
  };
  const exportCsv = () => {
    const csv = toCsv(
      rows.map((event) => ({
        at: event.at,
        agent: nameOf(event.agent_id),
        kind: t(`activity.kinds.${event.kind}`),
        text: textOf(event),
        target: event.tool ?? '',
        ms: event.ms,
        result: resultOf(event),
      })),
    );
    const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mango-actividad.csv';
    link.click();
    // Some browsers start the download asynchronously: revoking in the same tick can cancel it.
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
    notify(t('activity.exported', { count: rows.length }));
  };

  const crumbs = [t('activity.crumb'), t('activity.title')];
  if (state.kind === 'error' && state.forbidden) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <Denied view="activity" />
        </div>
      </>
    );
  }

  let body;
  if (state.kind === 'error') {
    body = (
      <div className="ac-grid is-one">
        <div role="alert">
          <GovErrorState
            title={t('activity.errorTitle')}
            body={t('activity.errorBody')}
            onRetry={retry}
          />
        </div>
      </div>
    );
  } else if (!page) {
    body = <Loading />;
  } else {
    body = (
      <div className="ac-grid">
        <div>
          {rows.length === 0 ? (
            <div className="card">
              <div className="mk-empty">
                <div className="ac-empty-t">{t('activity.emptyTitle')}</div>
                <div className="mk-meta">
                  {anyFilter ? t('activity.emptyFiltered') : t('activity.emptyPeriod')}
                </div>
                {anyFilter ? (
                  <button type="button" className="btn btn-sm" onClick={clear}>
                    {t('activity.clearFilters')}
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.key} className="ac-group">
                <div className="au-day-h">
                  {hourLabel(group.key, now, t('activity.yesterday'))}
                  <span>{group.items.length}</span>
                </div>
                <div className="card ac-card">
                  {group.items.map((event) => {
                    const agent = agentById.get(event.agent_id);
                    const KindIcon = KIND_ICON[event.kind];
                    const open = openId === event.id;
                    const sub = subOf(event);
                    const link = linkOf(event, canSeeBudgets);
                    const classes = ['ac-row'];
                    if (fresh.has(event.id)) classes.push('is-fresh');
                    if (event.kind === 'error') classes.push('is-err');
                    return (
                      <div key={event.id} className={classes.join(' ')}>
                        <button
                          type="button"
                          className="ac-main"
                          aria-expanded={open}
                          onClick={() => {
                            setOpenId(open ? null : event.id);
                          }}
                        >
                          <span className="mono au-time">{timeOf(event.at)}</span>
                          <AgentMark agent={agent} />
                          <span className="ac-body">
                            <span className="ac-t">
                              <b>{nameOf(event.agent_id)}</b> {textOf(event)}{' '}
                              {event.tool ? <code className="ac-target">{event.tool}</code> : null}
                            </span>
                            {sub ? (
                              <span className="ac-s">{t('activity.task', { name: sub })}</span>
                            ) : null}
                          </span>
                          <Slot event={event} />
                          <span
                            className={`ac-kind is-${event.kind}`}
                            title={t(`activity.kinds.${event.kind}`)}
                          >
                            <KindIcon size={12} />
                          </span>
                        </button>
                        {open ? (
                          <div className="ac-more">
                            {!event.mine ? (
                              <div className="mk-meta">{t(`activity.others.${event.kind}`)}</div>
                            ) : null}
                            <div className="ac-actions">
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => {
                                  setAgentFilter(event.agent_id);
                                  setOpenId(null);
                                }}
                              >
                                {t('activity.only', { name: nameOf(event.agent_id) })}
                              </button>
                              {link ? (
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  onClick={() => {
                                    void navigate(link.to);
                                  }}
                                >
                                  {t(`activity.links.${link.kind}`)} <ArrowRightIcon size={11} />
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))
          )}
          {rows.length > limit ? (
            <button
              type="button"
              className="btn btn-sm ac-more-btn"
              onClick={() => {
                setLimit((value) => value + PAGE);
              }}
            >
              {t('activity.more', { count: rows.length - limit })}
            </button>
          ) : rows.length > 0 && (capped || range === '7d') ? (
            <div className="mk-meta ac-retention">
              {capped ? <span>{t('activity.capped', { cap: CAP })}</span> : null}
              {range === '7d' ? (
                <span>{t('activity.retention', { days: page.retention_days })}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        <aside className="ac-side">
          <div className="card ac-card">
            <div className="ac-side-h">{t('activity.mostActive')}</div>
            {stats.byAgent.slice(0, 7).map((line) => (
              <button
                key={line.id}
                type="button"
                className={agentFilter === line.id ? 'ac-ag is-on' : 'ac-ag'}
                onClick={() => {
                  setAgentFilter(agentFilter === line.id ? 'all' : line.id);
                }}
              >
                <span className="ac-ag-row">
                  <span className="ac-ag-n">{nameOf(line.id)}</span>
                  <span className="mono mk-meta">
                    {line.n}
                    {line.err ? (
                      <span className="ac-err">{t('activity.errShort', { count: line.err })}</span>
                    ) : null}
                  </span>
                </span>
                <span className="mk-bar-track ac-bar">
                  <span
                    className={line.err ? 'is-err' : undefined}
                    style={{ width: `${String((line.n / maxN) * 100)}%` }}
                  />
                </span>
              </button>
            ))}
            {stats.byAgent.length === 0 ? (
              <div className="mk-meta ac-none">{t('activity.noActivity')}</div>
            ) : null}
          </div>
          {silent.length > 0 ? (
            <div className="card ac-card ac-silent-card">
              <div className="ac-side-h">{t('activity.silent')}</div>
              {silent.slice(0, 6).map((agent) => (
                <div key={agent.id} className="ac-silent">
                  <span>{agent.name}</span>
                </div>
              ))}
            </div>
          ) : null}
        </aside>
      </div>
    );
  }

  return (
    <>
      <Topbar
        crumbs={crumbs}
        actions={
          <>
            <button
              type="button"
              className={live && !blocked ? 'btn btn-sm ac-live-on' : 'btn btn-sm'}
              aria-pressed={live}
              disabled={blocked}
              title={t('activity.liveTitle')}
              onClick={() => {
                setLive((value) => !value);
              }}
            >
              {live ? (
                <>
                  <span className="ac-pulse" /> {t('activity.live')}
                </>
              ) : (
                <>
                  <PlayIcon size={11} /> {t('activity.resume')}
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={blocked || !rows.length}
              onClick={exportCsv}
            >
              <DownloadIcon size={12} /> {t('activity.export')}
            </button>
          </>
        }
      />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('activity.title')}</h1>
          <p className="page-subtitle">
            {everyone ? (
              <>
                {t('activity.subtitleAll')}
                <button
                  type="button"
                  className="sr-link ac-inline-link"
                  onClick={() => {
                    void navigate('/audit');
                  }}
                >
                  {t('activity.auditLog')}
                </button>
                .
              </>
            ) : (
              t('activity.subtitleMine')
            )}
          </p>
        </div>
        {state.kind === 'loading' ? (
          <LoadingKpis range={rangeLabel} />
        ) : page ? (
          <div className="bg-kpis">
            <div className="card bg-kpi">
              <span className="bg-kpi-l">{t('activity.kpi.events', { range: rangeLabel })}</span>
              <span className="bg-kpi-v">
                {capped ? t('activity.kpi.capped', { cap: CAP }) : period.length}
              </span>
              <span className="bg-kpi-s">
                {capped
                  ? t('activity.kpi.cappedShown', { cap: CAP })
                  : t('activity.kpi.calls', { count: stats.calls })}
              </span>
            </div>
            <div className="card bg-kpi">
              <span className="bg-kpi-l">{t('activity.kpi.agents')}</span>
              <span className="bg-kpi-v">{stats.activeAgents}</span>
              <span className="bg-kpi-s">
                {everyone
                  ? t('activity.kpi.published', { count: published.length })
                  : t('activity.kpi.mine')}
              </span>
            </div>
            <div className="card bg-kpi">
              <span className="bg-kpi-l">{t('activity.kpi.errors')}</span>
              <span className={stats.errors ? 'bg-kpi-v ac-err' : 'bg-kpi-v'}>
                {stats.calls
                  ? `${((stats.errors / stats.calls) * 100).toFixed(1).replace('.', ',')}%`
                  : '—'}
              </span>
              <span className="bg-kpi-s">
                {t('activity.kpi.errorsOf', { errors: stats.errors, calls: stats.calls })}
              </span>
            </div>
            <div className="card bg-kpi">
              <span className="bg-kpi-l">{t('activity.kpi.latency')}</span>
              <span className="bg-kpi-v">
                {stats.avgMs !== null ? formatDuration(stats.avgMs) : '—'}
              </span>
              <span className="bg-kpi-s">
                {stats.avgMs !== null
                  ? t('activity.kpi.measured', { count: stats.measured })
                  : t('activity.kpi.unmeasured')}
              </span>
            </div>
          </div>
        ) : null}
        <div className="bg-toolbar">
          <div className="search-wrap ac-search">
            <SearchIcon size={13} />
            <input
              className="input"
              placeholder={t('activity.search')}
              aria-label={t('activity.searchLabel')}
              value={query}
              maxLength={200}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
          <div className="tk-quick" role="group" aria-label={t('activity.period')}>
            {RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={range === item.key ? 'is-on' : ''}
                aria-pressed={range === item.key}
                onClick={() => {
                  if (item.key === range) return;
                  setState({ kind: 'loading' });
                  setLimit(PAGE);
                  setRange(item.key);
                }}
              >
                {t(`activity.ranges.${item.key}`)}
              </button>
            ))}
          </div>
          <select
            className="input mk-sel"
            aria-label={t('activity.agent')}
            value={agentFilter}
            onChange={(event) => {
              setAgentFilter(event.target.value);
            }}
          >
            <option value="all">{t('activity.allAgents')}</option>
            {(blocked ? [] : agentOptions).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <div className="ac-spacer" />
          {pollFailed && live && page ? (
            <span className="ac-poll" role="status">
              <WarnIcon size={12} /> {t('activity.pollFailed')}
            </span>
          ) : null}
          {anyFilter ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={clear}>
              {t('activity.clear')}
            </button>
          ) : null}
        </div>
        {page ? (
          <div className="au-cats ac-cats" role="group" aria-label={t('activity.kindGroup')}>
            <button
              type="button"
              className={kind === 'all' ? 'is-on' : ''}
              aria-pressed={kind === 'all'}
              onClick={() => {
                setKind('all');
              }}
            >
              {t('activity.all')}
              <span>{base.length}</span>
            </button>
            {KINDS.map((key) => {
              const count = base.filter((event) => event.kind === key).length;
              return count || kind === key ? (
                <button
                  key={key}
                  type="button"
                  className={kind === key ? 'is-on' : ''}
                  aria-pressed={kind === key}
                  onClick={() => {
                    setKind(key);
                  }}
                >
                  {t(`activity.kinds.${key}`)}
                  <span>{count}</span>
                </button>
              ) : null;
            })}
          </div>
        ) : null}
        {body}
      </div>
      {stack}
    </>
  );
}
