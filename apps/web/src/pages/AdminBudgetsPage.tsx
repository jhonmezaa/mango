import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adminErrorKey, isStaleDataError } from '../api/adminErrors';
import type { Budgets, UserBudget } from '../api/adminSchemas';
import { ApiError } from '../api/errors';
import { useSession } from '../auth/useSession';
import { DefaultsModal, UserBudgetModal, type SaveResult } from '../components/admin/BudgetModals';
import {
  BudgetDefaults,
  BudgetSection,
  UserBudgets,
  type BudgetLine,
} from '../components/admin/BudgetSections';
import { STATUS_COLOR, pctOf, periodInfo, statusOf, toNumber } from '../components/admin/govFormat';
import { Denied, GovErrorState, Skel } from '../components/admin/govKit';
import { useToasts } from '../components/admin/useToasts';
import { EditIcon, PlusIcon, SearchIcon, WarnIcon } from '../components/icons';
import { Soon } from '../components/Soon';
import { Topbar } from '../components/Topbar';

type LoadState = { kind: 'loading' } | { kind: 'ready'; data: Budgets } | { kind: 'error' };
type Editing = { kind: 'defaults' } | { kind: 'user'; user: UserBudget } | null;
type Filter = 'all' | 'risk' | 'out';
const FILTERS: Filter[] = ['all', 'risk', 'out'];

/**
 * Presupuestos y alertas (design audit-budgets.jsx `BudgetsView` in "disponibilidad actual"):
 * default limits, the FinOps agent and per-user limits (D17, TM-A3). Teams, projections,
 * thresholds, channels and "Nuevo presupuesto" have no backend yet ("Próximamente").
 * Every write sends `version`; a 409 reloads the data in the dialog (TM-A4).
 */
export function AdminBudgetsPage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const { notify, stack } = useToasts();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [forbidden, setForbidden] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    if (!me.is_admin) return;
    let cancelled = false;
    api.getBudgets().then(
      (data) => {
        if (!cancelled) setState({ kind: 'ready', data });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 403) setForbidden(true);
        setState({ kind: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, me.is_admin, reloadToken]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setReloadToken((value) => value + 1);
  }, []);

  /** Runs a write; a stale version fetches the current data for the dialog to show. */
  const save = async (
    write: (version: number) => Promise<Budgets>,
    done: string,
  ): Promise<SaveResult> => {
    if (state.kind !== 'ready')
      return { kind: 'error', error: { title: t('admin.errors.generic') } };
    try {
      const data = await write(state.data.version);
      setState({ kind: 'ready', data });
      setEditing(null);
      notify(done);
      return { kind: 'ok' };
    } catch (error) {
      if (isStaleDataError(error)) {
        try {
          const fresh = await api.getBudgets();
          setState({ kind: 'ready', data: fresh });
          return { kind: 'conflict', fresh };
        } catch (reloadError) {
          return { kind: 'error', error: { title: t(adminErrorKey(reloadError)) } };
        }
      }
      if (error instanceof ApiError && error.code === 'audit_unavailable') {
        return {
          kind: 'error',
          error: { title: t('budgets.errors.audit'), body: t('budgets.errors.auditBody') },
        };
      }
      return { kind: 'error', error: { title: t(adminErrorKey(error)) } };
    }
  };

  const crumbs = [t('budgets.crumbGov'), t('budgets.crumb')];
  if (!me.is_admin || forbidden) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <Denied />
        </div>
      </>
    );
  }

  const data = state.kind === 'ready' ? state.data : null;
  const month = periodInfo(data?.period, new Date());
  // Every agent with spend this month; the API names the ones it knows (rendered as text).
  const agentName = (agent: Budgets['agents'][number]) =>
    agent.name ?? (agent.agent_id === 'finops' ? t('agent.name') : agent.agent_id);
  const agentLines: BudgetLine[] = (data?.agents ?? []).map((agent) => ({
    id: agent.agent_id,
    name: agentName(agent),
    // The API has no per-agent limit: every agent uses the default (D17).
    sub: `${t('budgets.agent.onDefault')}${t('budgets.agent.action')}`,
    subTitle: t('budgets.agent.actionHint'),
    spent: agent.spent_usd,
    limit: agent.limit_usd,
    // Per-agent limits have no backend yet: the pencil is "Próximamente" (design audit-budgets.jsx).
    action: (
      <Soon name={t('budgets.editLabel', { name: agentName(agent) })}>
        <button type="button" className="btn btn-sm btn-ghost" tabIndex={-1}>
          <EditIcon size={12} />
        </button>
      </Soon>
    ),
  }));
  const percentOfLine = (line: BudgetLine) =>
    Math.round(pctOf(toNumber(line.spent), toNumber(line.limit)));
  const statusOfLine = (line: BudgetLine) => statusOf(percentOfLine(line));
  const needle = query.trim().toLowerCase();
  const visible = (line: BudgetLine) =>
    (!needle || line.name.toLowerCase().includes(needle)) &&
    (filter === 'all' ||
      (filter === 'risk' ? statusOfLine(line) !== 'ok' : statusOfLine(line) === 'out'));
  const shownAgents = agentLines.filter(visible);
  const filtering = needle !== '' || filter !== 'all';
  // Design `BudgetsView`: the highest consumption first.
  const alerts = agentLines
    .filter((line) => statusOfLine(line) !== 'ok')
    .sort((a, b) => percentOfLine(b) - percentOfLine(a));
  const clear = () => {
    setQuery('');
    setFilter('all');
  };

  return (
    <>
      <Topbar
        crumbs={crumbs}
        actions={
          <Soon name={t('budgets.new')} className="gov-topbar-soon">
            <button type="button" className="btn btn-sm btn-primary" tabIndex={-1}>
              <PlusIcon size={12} />
              {t('budgets.new')}
            </button>
          </Soon>
        }
      />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('budgets.title')}</h1>
          <p className="page-subtitle">
            {t('budgets.subtitle', { month: month.label, day: month.day, days: month.days })}
          </p>
        </div>

        <Soon block name={t('budgets.kpis.label')}>
          <div className="bg-kpis">
            {(['teams', 'projection', 'alerts', 'exceed'] as const).map((key) => (
              <div key={key} className="card bg-kpi">
                <span className="bg-kpi-l">{t(`budgets.kpis.${key}`)}</span>
                <span className="bg-kpi-v">—</span>
                <span className="bg-kpi-s">{t('budgets.kpis.noData')}</span>
              </div>
            ))}
          </div>
        </Soon>

        <div className="bg-toolbar">
          <div className="search-wrap max-w-[300px] flex-[1_1_220px]">
            <SearchIcon size={13} />
            <input
              className="input"
              placeholder={t('budgets.search')}
              aria-label={t('budgets.searchLabel')}
              maxLength={200}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
          <div className="tk-quick" role="group" aria-label={t('budgets.filterLabel')}>
            {FILTERS.map((key) => (
              <button
                key={key}
                type="button"
                className={filter === key ? 'is-on' : ''}
                aria-pressed={filter === key}
                onClick={() => {
                  setFilter(key);
                }}
              >
                {t(`budgets.filters.${key}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="budgets-grid">
          <div className="min-w-0">
            {state.kind === 'loading' && (
              <div aria-busy="true" aria-label={t('budgets.loading')}>
                <Skel w={140} h={12} className="mb-2.5" />
                <div className="card mb-7 p-4">
                  <Skel w="60%" />
                  <Skel w="40%" h={10} className="mt-2.5" />
                </div>
                <Skel w={140} h={12} className="mb-2.5" />
                <div className="card p-4">
                  <Skel w="70%" />
                  <Skel w="50%" h={10} className="mt-2.5" />
                </div>
              </div>
            )}
            {state.kind === 'error' && (
              <GovErrorState
                title={t('budgets.loadError')}
                body={t('budgets.loadErrorBody')}
                onRetry={retry}
              />
            )}
            {data && (
              <>
                {!filtering && (
                  <BudgetDefaults
                    data={data}
                    agentsOnDefault={agentLines.length}
                    onEdit={() => {
                      setEditing({ kind: 'defaults' });
                    }}
                  />
                )}
                {(!filtering || shownAgents.length > 0) && (
                  <BudgetSection
                    title={t('budgets.byAgent')}
                    lines={filtering ? shownAgents : agentLines}
                    labelledBy="budgets-agents"
                  />
                )}
                {!filtering && (
                  <UserBudgets
                    data={data}
                    meId={me.user_id}
                    onEdit={(user) => {
                      setEditing({ kind: 'user', user });
                    }}
                  />
                )}
                {!filtering && (
                  <Soon block name={t('budgets.byTeam')}>
                    <BudgetSection
                      title={t('budgets.byTeam')}
                      lines={[]}
                      labelledBy="budgets-teams"
                    />
                  </Soon>
                )}
                {filtering && shownAgents.length === 0 && (
                  <div className="mk-empty">
                    <div className="text-[14px] font-semibold">{t('budgets.noMatch')}</div>
                    <button type="button" className="btn btn-sm" onClick={clear}>
                      {t('budgets.clear')}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          {/* Available (design v14): real alerts, no click (editing opens from each section). */}
          <div className="bg-side">
            <div className="card p-0">
              <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
                <WarnIcon size={13} className="text-warn" />
                <span className="text-[13px] font-semibold">
                  {t('budgets.alerts.count', { count: alerts.length })}
                </span>
              </div>
              {alerts.length === 0 ? (
                <div className="px-4 pb-4 text-[12.5px] text-muted">{t('budgets.alerts.none')}</div>
              ) : (
                alerts.map((line) => (
                  <div key={line.id} className="bg-alert">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12.5px] font-medium">{line.name}</span>
                      <span
                        className="mono text-[11.5px]"
                        style={{ color: STATUS_COLOR[statusOfLine(line)] }}
                      >
                        {percentOfLine(line)}%
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {data && editing?.kind === 'defaults' && (
        <DefaultsModal
          data={data}
          onClose={() => {
            setEditing(null);
          }}
          onSave={(values) =>
            save(
              (version) =>
                api.putBudgetDefaults({
                  version,
                  user_monthly_usd: values.user,
                  agent_monthly_usd: values.agent,
                }),
              t('budgets.toast.defaults'),
            )
          }
        />
      )}
      {data && editing?.kind === 'user' && (
        <UserBudgetModal
          data={data}
          user={editing.user}
          onClose={() => {
            setEditing(null);
          }}
          onSave={(limit) =>
            save(
              (version) => api.putUserBudget(editing.user.user_id, { version, limit_usd: limit }),
              limit === null ? t('budgets.toast.userDefault') : t('budgets.toast.userOwn'),
            )
          }
        />
      )}
      {stack}
    </>
  );
}
