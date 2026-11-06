import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { usd } from '../../components/admin/govFormat';
import { useToasts } from '../../components/admin/useToasts';
import { InfoIcon, SearchIcon } from '../../components/icons';
import { OpsState } from '../../components/ops/OpsState';
import { retryAtOf } from '../../components/rateLimitWait';
import { Topbar } from '../../components/Topbar';
import { copyText } from '../../lib/clipboard';
import {
  PAGE,
  RANGES,
  SEARCH_DEBOUNCE_MS,
  STATUSES,
  TOP_AGENTS,
  TOP_TOOLS,
  appendPage,
  durationWidth,
  formatMs,
  intText,
  kTokens,
  kindOf,
  percentText,
  shortId,
  timeText,
  whoOf,
  type Range,
  type Reading,
  type StatusFilter,
  type Trace,
} from './model';
import { TraceDrawer } from './TraceDrawer';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'denied' }
  | { kind: 'rate'; until: number }
  | { kind: 'ready'; reading: Reading; traces: Trace[]; filters: object };

/**
 * Observability (design round 37 observability2.jsx; D108, D109): each turn of an agent as a
 * trace, from GET /api/observability. Only administrators (the API decides: Cedar
 * `ViewObservability`; the navigation only hides the entry). Metadata only: the response has no
 * text of a question, an answer or a tool. The server reads, joins, filters, searches and pages;
 * the KPIs, the hours, the agents and the tools are of the whole reading. Every value is text.
 */
export function ObservabilityPage() {
  const { t } = useTranslation();
  const { api, agents } = useSession();
  const navigate = useNavigate();
  const { notify, stack } = useToasts();
  const [range, setRange] = useState<Range>('24h');
  const [agent, setAgent] = useState('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [moreBusy, setMoreBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  // The search goes to the server (`q`) once typing stops: every reading counts against the
  // administrator's limit (30 a minute).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query]);

  const filters = useMemo(
    () => ({
      range,
      status,
      q: search,
      ...(agent === 'all' ? {} : { agent }),
    }),
    [range, status, search, agent],
  );

  useEffect(() => {
    const controller = new AbortController();
    api
      .call(
        'getObservability',
        { query: { ...filters, limit: PAGE } },
        { signal: controller.signal },
      )
      .then(
        (reading) => {
          setState({ kind: 'ready', reading, traces: reading.traces, filters });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          const until = retryAtOf(error);
          if (until !== null) setState({ kind: 'rate', until });
          else if (error instanceof ApiError && error.status === 403) setState({ kind: 'denied' });
          else setState({ kind: 'error' });
        },
      );
    return () => {
      controller.abort();
    };
  }, [api, filters, reloadToken]);

  const ready = state.kind === 'ready' ? state : null;
  // The previous reading stays on screen while the new filters are read (design: no flicker).
  const busy = ready !== null && ready.filters !== filters;
  const reading = ready?.reading ?? null;
  const traces = useMemo(() => ready?.traces ?? [], [ready]);

  const loadMore = () => {
    if (!ready || moreBusy) return;
    setMoreBusy(true);
    api
      .call('getObservability', {
        query: { ...filters, offset: ready.traces.length, limit: PAGE },
      })
      .then(
        (next) => {
          setState((current) =>
            current.kind === 'ready'
              ? { ...current, reading: next, traces: appendPage(current.traces, next.traces) }
              : current,
          );
          setMoreBusy(false);
        },
        (error: unknown) => {
          setMoreBusy(false);
          const until = retryAtOf(error);
          setState(until !== null ? { kind: 'rate', until } : { kind: 'error' });
        },
      );
  };

  const retry = () => {
    setState({ kind: 'loading' });
    setReloadToken((value) => value + 1);
  };

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of agents ?? []) map.set(item.id, item.name);
    for (const line of reading?.by_agent ?? [])
      if (line.agent_name) map.set(line.agent_id, line.agent_name);
    return map;
  }, [agents, reading]);
  const nameOf = useCallback(
    (id: string, name?: string | null) => name ?? names.get(id) ?? id,
    [names],
  );
  const agentOptions = useMemo(
    () =>
      [...names.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
    [names],
  );

  const copy = (id: string) => {
    copyText(id).then(
      () => {
        notify(t('observability.drawer.copied'));
      },
      () => {
        notify(t('observability.drawer.copyFailed'), 'error');
      },
    );
  };

  const crumbs = [t('observability.crumb'), t('observability.title')];
  if (state.kind === 'denied') {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <OpsState view="observability" kind="denied" />
        </div>
      </>
    );
  }

  const summary = reading?.summary ?? null;
  const capped = reading?.capped === true;
  const least = (value: string) => (capped ? t('observability.atLeast', { value }) : value);
  const p95 = summary?.p95_ms ?? null;
  const rangeLabel = t(`observability.ranges.${range}`);
  const hours = reading?.hourly ?? [];
  const maxHour = Math.max(1, ...hours.map((hour) => hour.ok + hour.error));
  const byAgent = (reading?.by_agent ?? []).slice(0, TOP_AGENTS);
  const maxP95 = Math.max(1, ...byAgent.map((line) => line.p95_ms));
  const tools = (reading?.tools ?? []).slice(0, TOP_TOOLS);
  const left = reading ? Math.max(0, reading.total - traces.length) : 0;
  const selectedTrace = selected ? traces.find((trace) => trace.id === selected) : undefined;

  let body;
  if (state.kind === 'loading') {
    body = <OpsState view="observability" kind="loading" />;
  } else if (state.kind === 'error') {
    body = <OpsState view="observability" kind="error" onRetry={retry} />;
  } else if (state.kind === 'rate') {
    body = <OpsState view="observability" kind="429" until={state.until} onRetry={retry} />;
  } else if (reading && summary) {
    body = (
      <>
        <div className="bg-kpis">
          <div className="card bg-kpi">
            <span className="bg-kpi-l">{t('observability.kpi.traces')}</span>
            <span className={capped ? 'bg-kpi-v ob-kpi-sm' : 'bg-kpi-v'}>
              {least(intText(summary.traces))}
            </span>
            <span className="bg-kpi-s">
              {t('observability.kpi.agents', { count: summary.agents })}
            </span>
          </div>
          <div className="card bg-kpi">
            <span className="bg-kpi-l">{t('observability.kpi.latency')}</span>
            <span className="bg-kpi-v ob-kpi-sm">
              {formatMs(summary.p50_ms ?? 0)} / {formatMs(summary.p95_ms ?? 0)}
            </span>
            <span className="bg-kpi-s">{t('observability.kpi.latencySub')}</span>
          </div>
          <div className="card bg-kpi">
            <span className="bg-kpi-l">{t('observability.kpi.errors')}</span>
            <span
              className={Number(summary.error_percent) > 5 ? 'bg-kpi-v ob-kpi-err' : 'bg-kpi-v'}
            >
              {percentText(summary.error_percent)}%
            </span>
            <span className="bg-kpi-s">
              {t('observability.kpi.errorsSub', { n: least(intText(summary.failed_by_tool)) })}
            </span>
          </div>
          <div className="card bg-kpi">
            <span className="bg-kpi-l">{t('observability.kpi.cost')}</span>
            <span className={capped ? 'bg-kpi-v ob-kpi-sm' : 'bg-kpi-v'}>
              {least(usd(summary.cost_usd))}
            </span>
            <span className="bg-kpi-s">
              {t('observability.kpi.costSub', {
                tokens: kTokens(summary.input_tokens + summary.output_tokens),
              })}
            </span>
          </div>
        </div>
        {capped ? (
          <div className="sr-cap ob-cap">
            <span>
              <InfoIcon size={13} />
              {t('observability.cap', { n: intText(summary.traces) })}
            </span>
          </div>
        ) : null}
      </>
    );
  }

  const toolbar = (
    <div className="bg-toolbar">
      <div className="search-wrap ob-search">
        <SearchIcon size={13} />
        <input
          className="input"
          placeholder={t('observability.search')}
          aria-label={t('observability.searchLabel')}
          value={query}
          maxLength={100}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>
      <div className="tk-quick" role="group" aria-label={t('observability.rangeLabel')}>
        {RANGES.map((key) => (
          <button
            key={key}
            type="button"
            className={range === key ? 'is-on' : ''}
            aria-pressed={range === key}
            onClick={() => {
              setRange(key);
            }}
          >
            {t(`observability.ranges.${key}`)}
          </button>
        ))}
      </div>
      <div className="tk-quick" role="group" aria-label={t('observability.statusLabel')}>
        {STATUSES.map((key) => (
          <button
            key={key}
            type="button"
            className={status === key ? 'is-on' : ''}
            aria-pressed={status === key}
            onClick={() => {
              setStatus(key);
            }}
          >
            {t(`observability.status.${key}`)}
          </button>
        ))}
      </div>
      <select
        className="input mk-sel"
        aria-label={t('observability.agentLabel')}
        value={agent}
        onChange={(event) => {
          setAgent(event.target.value);
        }}
      >
        <option value="all">{t('observability.allAgents')}</option>
        {agentOptions.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </div>
  );

  const content =
    reading && summary ? (
      <div className="ob-grid" aria-busy={busy}>
        <div className="min-w-0">
          <div
            className="card ob-hist"
            aria-label={t('observability.hist.label', { range: rangeLabel })}
          >
            <div className="ob-hist-h">
              <span className="mk-sec-t ob-hist-t">
                {t('observability.hist.title', { range: rangeLabel })}
              </span>
              <span className="mk-meta">
                <i className="ob-lg ob-tone-ok" /> {t('observability.hist.ok')}{' '}
                <i className="ob-lg ob-tone-error" /> {t('observability.hist.error')}
              </span>
            </div>
            <div
              className="ob-bars"
              style={{ gridTemplateColumns: `repeat(${String(Math.max(1, hours.length))}, 1fr)` }}
            >
              {hours.map((hour) => (
                <div
                  key={hour.hour}
                  title={t('observability.hist.bar', {
                    count: hour.ok + hour.error,
                    errors: hour.error,
                  })}
                >
                  <span
                    className="ob-tone-ok"
                    style={{ height: `${String((hour.ok / maxHour) * 100)}%` }}
                  />
                  <span
                    className="ob-tone-error"
                    style={{ height: `${String((hour.error / maxHour) * 100)}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="mk-meta ob-hist-f">
              <span>{t('observability.hist.since', { range: rangeLabel })}</span>
              <span>{t('observability.hist.now')}</span>
            </div>
          </div>
          <div className="card ob-table">
            <div className="ob-tr mc-th">
              <span>{t('observability.cols.trace')}</span>
              <span>{t('observability.cols.agent')}</span>
              <span>{t('observability.cols.duration')}</span>
              <span>{t('observability.cols.tools')}</span>
              <span>{t('observability.cols.cost')}</span>
              <span>{t('observability.cols.status')}</span>
            </div>
            {traces.map((trace) => {
              const toolSpans = trace.tool_calls;
              const slow = p95 !== null && trace.duration_ms >= p95;
              return (
                <button
                  key={trace.id}
                  type="button"
                  className={selected === trace.id ? 'ob-tr is-on' : 'ob-tr'}
                  onClick={() => {
                    setSelected(trace.id);
                  }}
                >
                  <span className="min-w-0">
                    <span className="ac-t ob-tr-t">
                      {t(`observability.row.${kindOf(trace)}`, { who: whoOf(trace) })}
                    </span>
                    <span className="mk-meta mono ob-tr-id">
                      {shortId(trace.id)} · {timeText(trace.started_at)}
                    </span>
                  </span>
                  <span className="mk-meta ob-ellipsis">
                    {nameOf(trace.agent_id, trace.agent_name)}
                  </span>
                  <span>
                    <span className="ob-mini">
                      <span
                        className={slow ? 'ob-tone-slow' : 'ob-tone-ok'}
                        style={{ width: `${String(durationWidth(trace.duration_ms, p95))}%` }}
                      />
                    </span>
                    <span className="mono ob-ms">{formatMs(trace.duration_ms)}</span>
                  </span>
                  <span className="mk-meta">
                    {toolSpans}
                    {trace.tools_failed > 0 ? (
                      <span className="ob-err">{t('observability.row.fails')}</span>
                    ) : null}
                  </span>
                  <span className="mono mk-meta ob-ms">
                    {trace.cost_usd === null ? '—' : usd(trace.cost_usd)}
                  </span>
                  <span className="ob-status">
                    <span
                      className={`tk-dot ${trace.status === 'error' ? 'ob-tone-error' : 'ob-tone-green'}`}
                    />
                    {t(`observability.states.${trace.status}`)}
                  </span>
                </button>
              );
            })}
            {traces.length === 0 ? (
              summary.traces > 0 ? (
                <div className="mk-meta ob-nomatch">{t('observability.noMatch')}</div>
              ) : (
                <OpsState view="observability" kind="empty" />
              )
            ) : null}
          </div>
          {left > 0 ? (
            <button
              type="button"
              className="btn btn-sm ob-more"
              disabled={moreBusy}
              onClick={loadMore}
            >
              {t('observability.more', { count: left })}
            </button>
          ) : null}
        </div>
        <aside className="ac-side">
          <div className="card ob-side-card">
            <div className="ac-side-h">{t('observability.side.latency')}</div>
            {byAgent.map((line) => (
              <button
                key={line.agent_id}
                type="button"
                className={agent === line.agent_id ? 'ac-ag is-on' : 'ac-ag'}
                aria-pressed={agent === line.agent_id}
                onClick={() => {
                  setAgent(agent === line.agent_id ? 'all' : line.agent_id);
                }}
              >
                <span className="ob-ag-row">
                  <span className="ac-ag-n">{nameOf(line.agent_id, line.agent_name)}</span>
                  <span className="mono mk-meta">
                    {formatMs(line.p95_ms)}
                    {line.failed ? (
                      <span className="ob-err">
                        {t('observability.side.errors', { count: line.failed })}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="mk-bar-track ob-ag-bar">
                  <span
                    className={line.failed ? 'ob-tone-slow' : 'ob-tone-ok'}
                    style={{ width: `${String((line.p95_ms / maxP95) * 100)}%` }}
                  />
                </span>
              </button>
            ))}
          </div>
          <div className="card ob-side-card ob-side-tools">
            <div className="ac-side-h">{t('observability.side.tools')}</div>
            {tools.map((tool) => (
              <div key={tool.name} className="ac-silent ob-tool">
                <span className="mono ob-tool-n">{tool.name}</span>
                <span className="mk-meta mono ob-tool-v">
                  {formatMs(tool.p95_ms)}
                  <br />
                  {tool.failed ? (
                    <span className="ob-err">
                      {t('observability.side.toolErrors', {
                        failed: tool.failed,
                        calls: tool.calls,
                      })}
                    </span>
                  ) : (
                    t('observability.side.toolCalls', { count: tool.calls })
                  )}
                </span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    ) : null;

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('observability.title')}</h1>
          <p className="page-subtitle">{t('observability.subtitle')}</p>
        </div>
        {body}
        {content ? toolbar : null}
        {content}
      </div>
      {selectedTrace ? (
        <TraceDrawer
          trace={selectedTrace}
          agentName={nameOf(selectedTrace.agent_id, selectedTrace.agent_name)}
          onClose={() => {
            setSelected(null);
          }}
          onCopy={copy}
          onActivity={() => {
            setSelected(null);
            void navigate('/activity');
          }}
        />
      ) : null}
      {stack}
    </>
  );
}
