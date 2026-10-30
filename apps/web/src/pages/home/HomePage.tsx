import type { TFunction } from 'i18next';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { usd } from '../../components/admin/govFormat';
import { GovErrorState, Skel } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import { WarnIcon } from '../../components/icons';
import { Soon } from '../../components/Soon';
import { SoonView } from '../../components/SoonView';
import { Topbar } from '../../components/Topbar';
import { useSession } from '../../auth/useSession';
import { canView, isAvailable, viewPath, type ViewKey } from '../../layouts/navigation';
import { formatRelative } from '../../lib/format';
import { InfoDot, ListCard, MetricCard, Pill, type ListRow } from './charts';
import {
  PERIODS,
  budgetPercent,
  effectiveGranularity,
  savePeriod,
  savedPeriod,
  seesOrganization,
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

/** «Ver detalles» of a card: a link to the view, or «Próximamente» while it does not exist. */
function More({ view, label, available }: { view: ViewKey; label: string; available: boolean }) {
  const navigate = useNavigate();
  return available ? (
    <button
      type="button"
      className="link-muted"
      onClick={() => {
        void navigate(viewPath(view));
      }}
    >
      {label}
    </button>
  ) : (
    <Soon name={label}>
      <span className="link-muted">{label}</span>
    </Soon>
  );
}

/** A card of the design without a backend yet (D24): its frame, no data, «Próximamente». */
function SoonCard({ title, info, children }: { title: string; info: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Soon block name={t('home.soonCard', { title })} className="hm-soon-card">
      <section className="card metric-card">
        <h2 className="hm-title">
          {title}
          <InfoDot text={info} />
        </h2>
        {children}
      </section>
    </Soon>
  );
}

function budgetRow(t: TFunction, budget: HomeBudget, agentName: string): ListRow {
  const percent = budgetPercent(budget);
  const name =
    budget.name ?? (budget.scope === 'agent' && budget.id === 'finops' ? agentName : budget.id);
  return {
    key: `${budget.scope}:${budget.id}`,
    label: name,
    sub: t('home.budgetOf', { spent: usd(budget.spent_usd), limit: usd(budget.limit_usd) }),
    value: `${String(percent)}%`,
    tone: percent >= 100 ? 'var(--red)' : percent >= WARN ? 'var(--amber)' : 'var(--text)',
    color: percent >= 100 ? 'var(--red)' : percent >= WARN ? 'var(--amber)' : 'var(--green)',
  };
}

const AGENT_STATES = [
  ['online', 'var(--green)'],
  ['warmup', 'var(--amber)'],
  ['degraded', 'var(--red)'],
  ['offline', 'var(--text-dim)'],
] as const;

const SKELETON_CARDS = [0, 1, 2, 3, 4, 5] as const;

interface CardsProps {
  data: Home;
  period: Period;
  gran: Granularity;
  compare: boolean;
  updated: string;
  canSeeBudgets: boolean;
  onExport: (series: Series, header: string, file: string) => void;
}

function Cards({ data, period, gran, compare, updated, canSeeBudgets, onExport }: CardsProps) {
  const { t } = useTranslation();
  const { me } = useSession();
  const g = effectiveGranularity(period, gran);
  const spend = useMemo(() => seriesOf(data, spentOf, g), [data, g]);
  const calls = useMemo(() => seriesOf(data, turnsOf, g), [data, g]);
  const rows = data.budgets.map((budget) => budgetRow(t, budget, t('agent.name')));
  return (
    <div className="metric-grid">
      <MetricCard
        title={t('home.spend')}
        info={t('home.spendInfo')}
        series={spend}
        money
        compare={compare}
        goodWhen="down"
        updated={updated}
        more={<More view="costs" label={t('home.details')} available={isAvailable('costs', me)} />}
        onExport={() => {
          onExport(spend, 'gasto_usd', 'gasto');
        }}
      />
      <SoonCard title={t('home.agents')} info={t('home.agentsInfo')}>
        <div>
          {AGENT_STATES.map(([state, color]) => (
            <div key={state} className="hm-list-row">
              <span className="hm-list-label">
                <span aria-hidden="true" className="hm-dot" style={{ background: color }} />
                <span>{t(`home.agentState.${state}`)}</span>
              </span>
              <span className="hm-num">—</span>
            </div>
          ))}
        </div>
      </SoonCard>
      <MetricCard
        title={t('home.calls')}
        info={t('home.callsInfo')}
        series={calls}
        compare={compare}
        updated={updated}
        more={
          <More
            view="observability"
            label={t('home.details')}
            available={isAvailable('observability', me)}
          />
        }
        onExport={() => {
          onExport(calls, 'invocaciones', 'invocaciones');
        }}
      />
      <SoonCard title={t('home.tickets')} info={t('home.ticketsInfo')}>
        <div className="hm-total">—</div>
        <div className="hm-chart-empty" />
      </SoonCard>
      <SoonCard title={t('home.latency')} info={t('home.latencyInfo')}>
        <div className="hm-total">—</div>
        <div className="hm-chart-empty" />
      </SoonCard>
      <ListCard
        title={t('home.budgets')}
        rows={rows}
        updated={updated}
        more={<More view="budgets" label={t('home.budgetsMore')} available={canSeeBudgets} />}
      />
    </div>
  );
}

function Loading() {
  const { t } = useTranslation();
  return (
    <div className="metric-grid" role="status" aria-label={t('home.loading')}>
      {SKELETON_CARDS.map((key) => (
        <section key={key} className="card metric-card">
          <Skel w="40%" h={14} />
          <Skel w="30%" h={24} className="hm-skel-gap" />
          <Skel h={200} className="hm-skel-gap" />
        </section>
      ))}
    </div>
  );
}

/**
 * Inicio (design dashboard.jsx, D102): spend and invocations per day from GET /api/home, the
 * approvals that wait for the person and the budgets closest to their limit. Agent health,
 * tickets and latency have no backend: «Próximamente». Administrators and central FinOps get the
 * view; anyone else keeps «Próximamente» until the design draws their variant (the API already
 * answers them with their own scope).
 */
export function HomePage() {
  const { t } = useTranslation();
  const { me } = useSession();
  return seesOrganization(me) ? <Dashboard /> : <SoonView label={t('nav.dashboard')} />;
}

function Dashboard() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const navigate = useNavigate();
  const { notify, stack } = useToasts();
  const [period, setPeriod] = useState<Period>(savedPeriod);
  const [gran, setGran] = useState<Granularity>('day');
  const [compare, setCompare] = useState(true);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

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

  const name = me.name ?? me.email ?? '';
  const greeting = greetingOf(t, new Date().getHours());
  const approvals = state.kind === 'ready' ? state.data.approvals : 0;
  const periodOptions = PERIODS.map((key) => [key, t(`home.period.${key}`)] as const);

  let body;
  if (state.kind === 'error') {
    body = (
      <div role="alert">
        <GovErrorState title={t('home.errorTitle')} body={t('home.errorBody')} onRetry={retry} />
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
        updated={t('home.updated', {
          when: formatRelative(new Date(state.loadedAt).toISOString()),
        })}
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
              <p className="page-subtitle">{t('home.subtitle')}</p>
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
