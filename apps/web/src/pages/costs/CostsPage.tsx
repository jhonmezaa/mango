import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { useToasts } from '../../components/admin/useToasts';
import { ClockIcon, DownloadIcon } from '../../components/icons';
import { OpsState } from '../../components/ops/OpsState';
import { RateWaitButton, RateWaitLine } from '../../components/RateWait';
import { retryAtOf } from '../../components/rateLimitWait';
import { SoonTag } from '../../components/Soon';
import { Topbar } from '../../components/Topbar';
import { CostAgent } from './CostAgent';
import { CostChart } from './CostChart';
import {
  GROUPS,
  PLAYGROUND,
  change,
  coversPrevious,
  formatCount,
  formatDay,
  formatMonth,
  formatShare,
  kmoney,
  linesOf,
  money,
  moversOf,
  num,
  sinceOf,
  toCsv,
  type AgentCost,
  type Costs,
  type Group,
  type Line,
} from './model';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; denied: boolean; retryAt: number | null }
  | { kind: 'ready'; data: Costs };

function Delta({ spent, previous }: { spent: number; previous: number | null }) {
  const { t } = useTranslation();
  const pct = change(spent, previous);
  if (pct === null) {
    return (
      <span
        className="mk-meta"
        title={previous === null ? t('costs.noPrevious') : t('costs.noPreviousSpend')}
      >
        —
      </span>
    );
  }
  const tone = pct > 10 ? 'co-up' : pct < -5 ? 'co-down' : 'co-flat';
  return (
    <span className={`mono co-delta ${tone}`}>
      {pct >= 0 ? '+' : ''}
      {Math.round(pct)}%
    </span>
  );
}

/**
 * Costos (design round 37 costs2.jsx; D105–D107): the month's Bedrock spend per day, agent,
 * model and origin, from GET /api/costs. Administrators and central FinOps see the same, the
 * agents' budgets included; «Presupuestos», «Ver presupuestos» and «Ver trazas» are only for
 * administrators. The API authorizes (`ViewCosts`); the navigation only hides the entry.
 * «Por equipo» and «Oportunidades de ahorro» are «Próximamente» (D107). Every value is text.
 */
export function CostsPage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const navigate = useNavigate();
  const { notify, stack } = useToasts();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const [group, setGroup] = useState<Group>('agent');
  const [selected, setSelected] = useState<string | null>(null);
  const admin = me.is_admin;

  useEffect(() => {
    const controller = new AbortController();
    api.call('getCosts', {}, { signal: controller.signal }).then(
      (data) => {
        setLoad({ kind: 'ready', data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({
          kind: 'error',
          denied: error instanceof ApiError && error.status === 403,
          retryAt: retryAtOf(error, Date.now()),
        });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, reload]);

  const retry = useCallback(() => {
    setLoad({ kind: 'loading' });
    setReload((value) => value + 1);
  }, []);

  const data = load.kind === 'ready' ? load.data : null;
  const agentName = useCallback(
    (row: AgentCost) =>
      row.name ?? (row.id === PLAYGROUND ? t('costs.row.playground') : t('costs.row.unknownAgent')),
    [t],
  );
  const agentSub = useCallback(
    (row: AgentCost) =>
      row.id === PLAYGROUND
        ? t('costs.row.playgroundSub')
        : [row.category, row.model].filter(Boolean).join(' · '),
    [t],
  );
  const lines = useMemo(() => (data ? linesOf(data, group) : []), [data, group]);

  const exportCsv = () => {
    if (!data) return;
    const csv = toCsv(data, {
      header: t('costs.csv.header'),
      noAgent: t('costs.row.noAgent'),
      pre: t('costs.row.pre'),
      noBreakdown: t('costs.csv.noBreakdown'),
      nameOf: agentName,
    });
    const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `mango-costos-${data.month}.csv`;
    link.click();
    // Some browsers start the download asynchronously: revoking in the same tick can cancel it.
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
    notify(t('costs.exported'));
  };

  const actions = data && (
    <>
      {admin && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            void navigate('/budgets');
          }}
        >
          {t('costs.budgets')}
        </button>
      )}
      <button type="button" className="btn btn-sm" onClick={exportCsv}>
        <DownloadIcon size={12} /> {t('costs.export')}
      </button>
    </>
  );
  const head = <Topbar crumbs={[t('costs.crumb'), t('costs.title')]} actions={actions} />;

  if (load.kind !== 'ready') {
    let body;
    if (load.kind === 'loading') body = <OpsState view="costs" kind="loading" />;
    else if (load.denied) body = <OpsState view="costs" kind="denied" />;
    else if (load.retryAt !== null) {
      body = (
        <div className="mk-empty" role="alert">
          <ClockIcon size={18} className="ops-state-lock" />
          <div className="ops-state-t">{t('costs.rateTitle')}</div>
          <div className="mk-meta ops-state-d">
            <RateWaitLine until={load.retryAt} />
          </div>
          <RateWaitButton until={load.retryAt} onRetry={retry} />
        </div>
      );
    } else body = <OpsState view="costs" kind="error" onRetry={retry} />;
    return (
      <>
        {head}
        <div className="content">{body}</div>
      </>
    );
  }

  const costs = load.data;
  const total = num(costs.spent_usd);
  if (total <= 0) {
    return (
      <>
        {head}
        <div className="content">
          <OpsState view="costs" kind="empty" />
        </div>
      </>
    );
  }

  const previousTotal = num(costs.previous_usd);
  const projected = costs.projected_usd === null ? null : num(costs.projected_usd);
  const queries = costs.turns;
  const top = costs.agents.rows[0];
  const since = sinceOf(costs, group);
  const agentSince = costs.agents.counted_since;
  const movers = moversOf(costs);
  const max = Math.max(1e-9, ...lines.map((line) => line.spent));
  const selectedRow = selected ? costs.agents.rows.find((row) => row.id === selected) : undefined;
  const modelCount = (id: string) => costs.agents.rows.filter((row) => row.model === id).length;

  const labelOf = (line: Line): { label: string; sub: string; mono?: boolean } => {
    if (line.kind === 'pre') {
      return {
        label: t('costs.row.pre'),
        sub: since ? t('costs.row.preSince', { date: formatDay(since) }) : t('costs.row.preNever'),
      };
    }
    if (line.kind === 'none') {
      const label = { agent: 'noAgent', model: 'noModel', source: 'noSource' } as const;
      return { label: t(`costs.row.${label[group]}`), sub: t('costs.row.titles') };
    }
    if (group === 'agent') {
      const row = costs.agents.rows.find((r) => r.id === line.id);
      return row ? { label: agentName(row), sub: agentSub(row) } : { label: line.id, sub: '' };
    }
    if (group === 'model') {
      return {
        label: line.id,
        mono: true,
        sub: [
          t('costs.row.viaBedrock'),
          t('costs.row.agents', { count: modelCount(line.id) }),
        ].join(' · '),
      };
    }
    const source = line.id as 'chat' | 'task' | 'eval' | 'playground';
    return { label: t(`costs.source.${source}`), sub: t(`costs.source.${source}Sub`) };
  };

  return (
    <>
      {head}
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('costs.title')}</h1>
          <p className="page-subtitle">
            {t('costs.subtitle', {
              month: formatMonth(costs.month),
              day: costs.elapsed_days,
              days: costs.days_in_month,
            })}
          </p>
        </div>
        <div className="bg-kpis">
          <div className="card bg-kpi">
            <span className="bg-kpi-l">{t('costs.kpi.spent')}</span>
            <span className="bg-kpi-v">{kmoney(total)}</span>
            <span className="bg-kpi-s">
              <Delta
                spent={total}
                previous={coversPrevious(costs.counted_since, costs) ? previousTotal : null}
              />{' '}
              {t('costs.kpi.vsPrevious', { amount: kmoney(previousTotal) })}
            </span>
          </div>
          <div className="card bg-kpi">
            <span className="bg-kpi-l">{t('costs.kpi.projection')}</span>
            <span className="bg-kpi-v">{projected === null ? '—' : kmoney(projected)}</span>
            <span className="bg-kpi-s">
              {projected === null ? t('costs.kpi.fewDays') : t('costs.kpi.atPace')}
            </span>
          </div>
          <div className="card bg-kpi">
            <span className="bg-kpi-l">{t('costs.kpi.perQuery')}</span>
            <span className="bg-kpi-v">{money(total / Math.max(1, queries))}</span>
            <span className="bg-kpi-s">{t('costs.kpi.queries', { n: formatCount(queries) })}</span>
          </div>
          <div className="card bg-kpi">
            <span className="bg-kpi-l">{t('costs.kpi.top')}</span>
            <span className="bg-kpi-v co-kpi-name">{top ? agentName(top) : '—'}</span>
            <span className="bg-kpi-s">
              {top
                ? t('costs.kpi.topShare', {
                    pct: Math.round((num(top.spent_usd) / total) * 100),
                  })
                : ''}
            </span>
          </div>
        </div>
        <div className="ob-grid co-grid">
          <div className="min-w-0">
            <CostChart data={costs} />
            <div className="co-bar">
              <div className="min-w-0">
                <h2 className="mk-sec-t co-flush">{t('costs.breakdown')}</h2>
                <div className="mk-meta co-since">
                  {since ? t('costs.since', { date: formatDay(since) }) : t('costs.notYet')}
                </div>
              </div>
              <div className="tk-quick">
                {GROUPS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={group === key ? 'is-on' : ''}
                    aria-pressed={group === key}
                    onClick={() => {
                      setGroup(key);
                    }}
                  >
                    {t(`costs.group.${key}`)}
                  </button>
                ))}
                <button type="button" disabled title={t('costs.soonTitle')} className="co-soon-btn">
                  {t('costs.group.team')} <SoonTag />
                </button>
              </div>
            </div>
            <div className="card co-table">
              <div className="co-tr mc-th">
                <span>{t(`costs.column.${group}`)}</span>
                <span>{t('costs.column.spent')}</span>
                <span className="co-r">{t('costs.column.vs')}</span>
                <span className="co-r">{t('costs.column.share')}</span>
              </div>
              {lines.map((line) => {
                const { label, sub, mono } = labelOf(line);
                const flat = line.kind !== 'row';
                const cells = (
                  <>
                    <span className="min-w-0">
                      <span
                        className={`mk-name co-block${flat ? ' co-grey' : ''}${mono ? ' mono' : ''}`}
                      >
                        {label}
                      </span>
                      <span className="mk-meta co-block co-ellipsis">{sub}</span>
                    </span>
                    <span>
                      <span className="mk-bar-track co-track">
                        <span
                          className={flat ? 'co-fill-grey' : 'co-fill'}
                          style={{ width: `${String((line.spent / max) * 100)}%` }}
                        />
                      </span>
                      <span className="mono co-amount">{money(line.spent)}</span>
                    </span>
                    <span className="co-r">
                      {flat ? (
                        <span className="mk-meta">—</span>
                      ) : (
                        <Delta spent={line.spent} previous={line.previous} />
                      )}
                    </span>
                    <span className="mono mk-meta co-r">
                      {formatShare((line.spent / total) * 100)}%
                    </span>
                  </>
                );
                return line.open ? (
                  <button
                    key={line.key}
                    type="button"
                    className="co-tr"
                    onClick={() => {
                      setSelected(line.id);
                    }}
                  >
                    {cells}
                  </button>
                ) : (
                  <div key={line.key} className="co-tr co-static">
                    {cells}
                  </div>
                );
              })}
            </div>
            {group === 'agent' && <div className="mk-meta co-note">{t('costs.titlesNote')}</div>}
          </div>
          <aside className="ac-side">
            <div className="card co-side">
              <h2 className="ac-side-h">{t('costs.movers.title')}</h2>
              {movers === null ? (
                <div className="mk-meta co-side-p">
                  {agentSince
                    ? t('costs.movers.none', { date: formatDay(agentSince) })
                    : t('costs.movers.noneNever')}
                </div>
              ) : movers.length === 0 ? (
                <div className="mk-meta co-side-p">{t('costs.movers.same')}</div>
              ) : (
                movers.map(({ row, delta }) => (
                  <button
                    key={row.id}
                    type="button"
                    className="ac-ag"
                    onClick={() => {
                      setSelected(row.id);
                    }}
                  >
                    <span className="co-mover">
                      <span className="ac-ag-n">{agentName(row)}</span>
                      <span className={`mono co-mover-d ${delta > 0 ? 'co-up' : 'co-down'}`}>
                        {delta > 0 ? '+' : '−'}
                        {money(Math.abs(delta))}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="card co-side co-side-next">
              <h2 className="ac-side-h co-side-soon">
                <span>{t('costs.savings.title')}</span>
                <SoonTag />
              </h2>
              <div className="mk-meta co-side-p">{t('costs.savings.body')}</div>
            </div>
          </aside>
        </div>
      </div>
      {selectedRow && (
        <CostAgent
          row={selectedRow}
          name={agentName(selectedRow)}
          sub={agentSub(selectedRow)}
          data={costs}
          admin={admin}
          onClose={() => {
            setSelected(null);
          }}
        />
      )}
      {stack}
    </>
  );
}
