import type { TFunction } from 'i18next';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { usd } from '../../components/admin/govFormat';
import { Skel } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import { WarnIcon } from '../../components/icons';
import { Topbar } from '../../components/Topbar';
import { useSession } from '../../auth/useSession';
import { canView, viewPath } from '../../layouts/navigation';
import { ListCard, MetricCard, Pill, type ListRow } from './charts';
import {
  PERIODS,
  agoOf,
  budgetPercent,
  effectiveGranularity,
  expectedScope,
  savePeriod,
  savedPeriod,
  seriesOf,
  spentOf,
  toCsv,
  turnsOf,
  type Granularity,
  type Home,
  type HomeBudget,
  type Period,
  type Series,
} from './model';

type LoadState =
  { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: Home; loadedAt: number };

const WARN = 80;
/** How often «Actualizado …» is read again (design). */
const UPDATED_EVERY_MS = 15_000;

function greetingOf(t: TFunction, hour: number): string {
  if (hour < 12) return t('home.morning');
  return hour < 19 ? t('home.afternoon') : t('home.evening');
}

function download(csv: string, name: string): void {
  const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // Some browsers start the download asynchronously: revoking in the same tick can cancel it.
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function updatedOf(t: TFunction, ms: number): string {
  const { unit, count } = agoOf(ms);
  if (unit === 'seconds') return t('home.updatedNow');
  return t(unit === 'minutes' ? 'home.updatedMinutes' : 'home.updatedHours', { count });
}

function budgetRow(t: TFunction, budget: HomeBudget, agentName: string): ListRow {
  const percent = budgetPercent(budget);
  const agent =
    budget.name ?? (budget.scope === 'agent' && budget.id === 'finops' ? agentName : budget.id);
  const name = budget.scope === 'user' ? t('home.personalLimit') : agent;
  return {
    key: `${budget.scope}:${budget.id}`,
    label: name,
    sub: t('home.budgetOf', { spent: usd(budget.spent_usd), limit: usd(budget.limit_usd) }),
    value: `${String(percent)}%`,
    tone: percent >= 100 ? 'var(--red)' : percent >= WARN ? 'var(--amber)' : 'var(--text)',
    color: percent >= 100 ? 'var(--red)' : percent >= WARN ? 'var(--amber)' : 'var(--green)',
  };
}

const SKELETON_CARDS = [0, 1, 2] as const;

interface CardsProps {
  data: Home;
  period: Period;
  gran: Granularity;
  compare: boolean;
  updated: string;
  canSeeBudgets: boolean;
  onExport: (series: Series, header: string, file: string) => void;
}

/** Memoized: «Actualizado» is read every few seconds and its text rarely changes. */
const Cards = memo(function Cards({
  data,
  period,
  gran,
  compare,
  updated,
  canSeeBudgets,
  onExport,
}: CardsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const g = effectiveGranularity(period, gran);
  const spend = useMemo(() => seriesOf(data, spentOf, g), [data, g]);
  const calls = useMemo(() => seriesOf(data, turnsOf, g), [data, g]);
  const rows = data.budgets.map((budget) => budgetRow(t, budget, t('agent.name')));
  const since = data.counted_since;
  return (
    <div className="metric-grid">
      <MetricCard
        title={t('home.spend')}
        info={t(`home.spendInfo.${data.scope}`)}
        series={spend}
        money
        compare={compare}
        goodWhen="down"
        updated={updated}
        since={since}
        onExport={() => {
          onExport(spend, 'gasto_usd', 'gasto');
        }}
      />
      <MetricCard
        title={t('home.calls')}
        info={t(`home.callsInfo.${data.scope}`)}
        series={calls}
        compare={compare}
        updated={updated}
        since={since}
        onExport={() => {
          onExport(calls, 'invocaciones', 'invocaciones');
        }}
      />
      {data.budgets_scope === 'agents' ? (
        <ListCard
          title={t('home.budgets')}
          info={t('home.budgetsInfo')}
          rows={rows}
          updated={updated}
          more={
            canSeeBudgets ? (
              <button
                type="button"
                className="link-muted"
                onClick={() => {
                  void navigate(viewPath('budgets'));
                }}
              >
                {t('home.budgetsMore')}
              </button>
            ) : null
          }
        />
      ) : (
        <ListCard
          title={t('home.myBudget')}
          info={t(data.scope === 'area' ? 'home.myBudgetInfoArea' : 'home.myBudgetInfo')}
          rows={rows}
          updated={updated}
        />
      )}
    </div>
  );
});

function Loading() {
  const { t } = useTranslation();
  return (
    <div className="metric-grid" role="status" aria-busy="true" aria-label={t('home.loading')}>
      {SKELETON_CARDS.map((key) => (
        <section key={key} className="card metric-card hm-skel-card" aria-hidden="true">
          <Skel w={140} h={14} />
          <Skel w={120} h={26} />
          <Skel w={160} h={12} />
          <Skel h={200} className="hm-skel-chart" />
        </section>
      ))}
    </div>
  );
}

/**
 * Inicio (design dashboard.jsx, round 28, D102): spend and invocations per day from GET
 * /api/home, the approvals that wait for the person and the budgets. Whose numbers they are comes
 * from the answer: the organization, the person's area or their own. Agent health, tickets and
 * latency have no source and are not shown (D102 (10)).
 */
export function HomePage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const navigate = useNavigate();
  const { notify, stack } = useToasts();
  const [period, setPeriod] = useState<Period>(savedPeriod);
  const [gran, setGran] = useState<Granularity>('day');
  const [compare, setCompare] = useState(true);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, UPDATED_EVERY_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api.call('getHome', { query: { period } }, { signal: controller.signal }).then(
      (data) => {
        setState({ kind: 'ready', data, loadedAt: Date.now() });
      },
      () => {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, period, reloadToken]);

  const choosePeriod = useCallback((next: Period) => {
    savePeriod(next);
    setState({ kind: 'loading' });
    setPeriod(next);
  }, []);
  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setReloadToken((value) => value + 1);
  }, []);
  const exportCsv = useCallback(
    (series: Series, header: string, file: string) => {
      download(toCsv(series, header), `mango-inicio-${file}-${period}.csv`);
      notify(t('home.exported'));
    },
    [notify, period, t],
  );

  const name = me.name ?? '';
  const ready = state.kind === 'ready' ? state.data : null;
  const scope = ready ? ready.scope : expectedScope(me);
  const area = (ready ? ready.area : me.business_unit) ?? '';
  const greeting = greetingOf(t, new Date().getHours());
  const approvals = ready?.approvals ?? 0;
  const periodOptions = PERIODS.map((key) => [key, t(`home.period.${key}`)] as const);

  let body;
  if (state.kind === 'error') {
    body = (
      <div className="card dash-error" role="alert">
        <WarnIcon size={16} className="dash-error-icon" />
        <div>
          <h2>{t('home.errorTitle')}</h2>
          <p>{t('home.errorBody')}</p>
        </div>
        <button type="button" className="btn" onClick={retry}>
          {t('errors.retry')}
        </button>
      </div>
    );
  } else if (state.kind === 'loading') {
    body = <Loading />;
  } else {
    body = (
      <Cards
        data={state.data}
        period={period}
        gran={gran}
        compare={compare}
        updated={updatedOf(t, now - state.loadedAt)}
        canSeeBudgets={canView(me, 'budgets') && state.data.budgets_scope === 'agents'}
        onExport={exportCsv}
      />
    );
  }

  return (
    <>
      <Topbar crumbs={[t('nav.dashboard')]} />
      <div className="content">
        <div className="hm-wrap">
          <div className="hm-top">
            <div>
              <h1 className="page-title">
                {name ? t('home.greeting', { greeting, name }) : greeting}
              </h1>
              <p className="page-subtitle">{t(`home.subtitle.${scope}`, { area })}</p>
            </div>
            {approvals > 0 ? (
              <button
                type="button"
                className="notice-pill"
                onClick={() => {
                  void navigate(viewPath('approvals'));
                }}
              >
                <WarnIcon size={14} className="hm-warn" />
                <span>{t('home.approvals', { count: approvals })}</span>
              </button>
            ) : null}
          </div>
          <div className="hm-filters">
            <Pill
              label={t('home.periodLabel')}
              value={period}
              options={periodOptions}
              onChange={choosePeriod}
            />
            <Pill
              value={gran}
              options={[
                ['day', t('home.daily')],
                ['week', t('home.weekly')],
              ]}
              onChange={setGran}
            />
            {compare ? (
              <Pill
                label={t('home.compare')}
                value="prev"
                options={[['prev', t('home.previousPeriod')]]}
                onChange={() => undefined}
                onRemove={() => {
                  setCompare(false);
                }}
                removeLabel={t('home.removeCompare')}
              />
            ) : (
              <button
                type="button"
                className="filter-pill"
                onClick={() => {
                  setCompare(true);
                }}
              >
                <span className="hm-muted">{t('home.addCompare')}</span>
              </button>
            )}
          </div>
          {body}
        </div>
      </div>
      {stack}
    </>
  );
}
