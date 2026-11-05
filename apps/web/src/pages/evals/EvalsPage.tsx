import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { ApiError } from '../../api/errors';
import { agentIdSchema } from '../../api/schemas';
import { useSession } from '../../auth/useSession';
import { useToasts } from '../../components/admin/useToasts';
import { EyeIcon, PlayIcon, PlusIcon, SearchIcon } from '../../components/icons';
import { OpsState } from '../../components/ops/OpsState';
import { Topbar } from '../../components/Topbar';
import { formatRelative } from '../../lib/format';
import { EvalCreate } from './EvalCreate';
import { EvalDetail } from './EvalDetail';
import {
  blocks,
  issueOf,
  issueTone,
  statusOf,
  trendDelta,
  type Suite,
  type SuiteList,
} from './model';
import { EvSpark } from './parts';
import { errorText, issueLabel, pct, type Agent } from './text';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'denied' }
  | { kind: 'ready'; list: SuiteList; agents: Agent[]; models: Map<string, string> };
type Quick = 'all' | 'fail' | 'blocking' | 'pass';

const QUICK: readonly Quick[] = ['all', 'fail', 'blocking', 'pass'];
/** Someone else may change or run a suite while the page is open. */
const POLL_MS = 20_000;
/** While a run holds a suite, its progress is read this often (design: «Caso {n} de {total}»). */
const RUN_POLL_MS = 3_000;

function matches(suite: Suite, quick: Quick): boolean {
  if (quick === 'all') return true;
  if (quick === 'blocking') return blocks(suite);
  return statusOf(suite) === quick;
}

/** Review › «Crear eval» opens the dialog for its agent: router state, untrusted input. */
function createFor(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('evalsCreateFor' in state)) return null;
  const parsed = agentIdSchema.safeParse(state.evalsCreateFor);
  return parsed.success ? parsed.data : null;
}

/**
 * Operación › Evals (design evals.jsx; D110, D111). The API returns the suites the account may
 * see (admins and FinOps central all, a creator those of the agents they edit) and, per suite,
 * whether it may change it (`can_edit`): the buttons only follow that answer (REACT-AUTHZ-001).
 */
export function EvalsPage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const call = api.call;
  const { notify, stack } = useToasts();
  const location = useLocation();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const [quick, setQuick] = useState<Quick>('all');
  const [agentFilter, setAgentFilter] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(() => createFor(location.state));
  const [starting, setStarting] = useState<string | null>(null);
  /** Runs seen holding a suite: their end is told once (design toast). */
  const openRuns = useRef(new Map<string, string>());

  const ready = state.kind === 'ready' ? state : null;
  const anyRunning = ready?.list.suites.some((suite) => suite.active_run) ?? false;
  const refresh = useCallback(() => {
    setReload((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const load = (first: boolean) => {
      Promise.all([
        call('getEvals', {}, { signal }),
        call('getAgents', {}, { signal }),
        // The judge selector names the models; without the catalog it shows their ids.
        call('getModels', {}, { signal }).catch(() => null),
      ]).then(
        ([list, agents, models]) => {
          if (signal.aborted) return;
          const seen = openRuns.current;
          for (const suite of list.suites) {
            if (suite.active_run) {
              seen.set(suite.active_run.run_id, suite.suite_id);
              continue;
            }
            const attempt = suite.last_attempt;
            if (!attempt || !seen.delete(attempt.run_id)) continue;
            const issue = issueOf(attempt);
            if (issue) {
              notify(
                t('evals.toast.stopped', { name: suite.name, issue: issueLabel(t, issue) }),
                'error',
              );
            } else if (suite.last_run) {
              const passed = suite.last_run.passed;
              notify(
                passed
                  ? t('evals.toast.passed', { name: suite.name, pct: pct(suite.last_run.score) })
                  : t('evals.toast.failed', {
                      name: suite.name,
                      pct: pct(suite.last_run.score),
                      threshold: pct(suite.threshold),
                    }),
                passed ? 'success' : 'error',
              );
            }
          }
          setState({
            kind: 'ready',
            list,
            agents: agents.items,
            models: new Map((models?.items ?? []).map((model) => [model.id, model.name])),
          });
        },
        (cause: unknown) => {
          if (signal.aborted || !first) return;
          setState({
            kind: cause instanceof ApiError && cause.status === 403 ? 'denied' : 'error',
          });
        },
      );
    };
    load(true);
    const timer = window.setInterval(
      () => {
        if (document.visibilityState !== 'hidden') load(false);
      },
      anyRunning ? RUN_POLL_MS : POLL_MS,
    );
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [call, reload, anyRunning, notify, t]);

  const agents = useMemo(() => ready?.agents ?? [], [ready]);
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  // Design evEdits: admin, or whoever may create agents and created this one. Only to offer
  // «Nueva suite»; the API decides with EditEvals on every write.
  const editable = useMemo(
    () =>
      agents.filter(
        (agent) =>
          agent.status === 'published' && (me.is_admin || (me.can.create_agent && agent.is_mine)),
      ),
    [agents, me.is_admin, me.can.create_agent],
  );
  const central = me.is_admin || me.role === 'finops-central';
  const suites = useMemo(() => ready?.list.suites ?? [], [ready]);
  const q = query.trim().toLowerCase();
  const base = useMemo(
    () =>
      suites.filter(
        (suite) =>
          (agentFilter === 'all' || suite.agent_id === agentFilter) &&
          (!q || `${suite.name} ${suite.description}`.toLowerCase().includes(q)),
      ),
    [suites, agentFilter, q],
  );
  const list = base.filter((suite) => matches(suite, quick));
  const blocking = suites.filter(blocks);
  const agentName = (id: string) => agentsById.get(id)?.name ?? id;
  const selectedSuite = selected ? suites.find((suite) => suite.suite_id === selected) : undefined;

  const run = (suite: Suite) => {
    const agent = agentsById.get(suite.agent_id);
    if (!agent || agent.status !== 'published') return;
    setStarting(suite.suite_id);
    call('postEvalRun', {
      path: { suite_id: suite.suite_id },
      // «Ejecutar ahora» runs on the published version of the agent.
      body: { version: agent.version },
    })
      .then(
        (started) => {
          openRuns.current.set(started.run_id, suite.suite_id);
          notify(t('evals.toast.started', { name: suite.name }), 'info');
          refresh();
        },
        (cause: unknown) => {
          notify(errorText(t, cause), 'error');
          if (cause instanceof ApiError && cause.status === 409) refresh();
        },
      )
      .finally(() => {
        setStarting(null);
      });
  };
  const canRun = (suite: Suite) =>
    suite.can_edit && agentsById.get(suite.agent_id)?.status === 'published';

  const newSuite = editable.length > 0 && (
    <button
      type="button"
      className="btn btn-sm btn-primary"
      onClick={() => {
        setCreating(editable[0]?.id ?? null);
      }}
    >
      <PlusIcon size={12} /> {t('evals.newSuite')}
    </button>
  );
  const head = (
    <Topbar crumbs={[t('evals.crumbOps'), t('evals.title')]} actions={ready ? newSuite : null} />
  );
  const dialogs = (
    <>
      {ready && creating && editable.length > 0 && (
        <EvalCreate
          agents={editable}
          initialAgent={creating}
          judgeModels={ready.list.judge_models}
          modelNames={ready.models}
          onClose={() => {
            setCreating(null);
          }}
          onCreated={(created, submit) => {
            setCreating(null);
            notify(submit ? t('evals.toast.createdSubmit') : t('evals.toast.created'));
            setSelected(created);
            refresh();
          }}
        />
      )}
      {selectedSuite && (
        <EvalDetail
          suite={selectedSuite}
          agentName={agentName(selectedSuite.agent_id)}
          canRun={canRun(selectedSuite)}
          starting={starting === selectedSuite.suite_id}
          notify={notify}
          onRun={() => {
            run(selectedSuite);
          }}
          onChanged={refresh}
          onClose={() => {
            setSelected(null);
          }}
        />
      )}
      {stack}
    </>
  );

  if (state.kind !== 'ready' || !suites.length) {
    const kind = state.kind === 'ready' ? 'empty' : state.kind;
    return (
      <>
        {head}
        <div className="content">
          <OpsState
            view="evals"
            kind={kind}
            onRetry={() => {
              setState({ kind: 'loading' });
              refresh();
            }}
            action={kind === 'empty' ? newSuite : undefined}
          />
        </div>
        {dialogs}
      </>
    );
  }

  return (
    <>
      {head}
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('evals.title')}</h1>
          <p className="page-subtitle">{t('evals.subtitle')}</p>
        </div>
        {!editable.length && (
          <div className="mc-alert ev-readonly">
            <EyeIcon size={14} />
            <div>{t('evals.readOnly')}</div>
          </div>
        )}
        <div className="bg-kpis">
          <div className="card bg-kpi">
            <span className="bg-kpi-l">{t('evals.kpi.suites')}</span>
            <span className="bg-kpi-v">{suites.length}</span>
            <span className="bg-kpi-s">
              {t('evals.kpi.required', { count: suites.filter((s) => s.required).length })}
            </span>
          </div>
          <div className="card bg-kpi">
            <span className="bg-kpi-l">{t('evals.kpi.pass')}</span>
            <span className="bg-kpi-v ev-green">
              {suites.filter((s) => statusOf(s) === 'pass').length}
            </span>
            <span className="bg-kpi-s">{t('evals.kpi.of', { count: suites.length })}</span>
          </div>
          <div className="card bg-kpi">
            <span className="bg-kpi-l">{t('evals.kpi.blocking')}</span>
            <span className={blocking.length ? 'bg-kpi-v ev-red' : 'bg-kpi-v'}>
              {blocking.length}
            </span>
            <span className="bg-kpi-s">
              {blocking.length
                ? [...new Set(blocking.map((s) => agentName(s.agent_id)))].join(', ')
                : t('evals.kpi.none')}
            </span>
          </div>
          {central && (
            <div className="card bg-kpi">
              <span className="bg-kpi-l">{t('evals.kpi.withoutEvals')}</span>
              <span className="bg-kpi-v">
                {agents.filter((a) => !suites.some((s) => s.agent_id === a.id)).length}
              </span>
              <span className="bg-kpi-s">{t('evals.kpi.ofAgents', { count: agents.length })}</span>
            </div>
          )}
        </div>
        <div className="bg-toolbar">
          <div className="search-wrap ev-search">
            <SearchIcon size={13} />
            <input
              className="input"
              placeholder={t('evals.search')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              aria-label={t('evals.searchLabel')}
            />
          </div>
          <div className="tk-quick" role="group" aria-label={t('evals.quickLabel')}>
            {QUICK.map((key) => (
              <button
                key={key}
                type="button"
                className={quick === key ? 'is-on' : ''}
                aria-pressed={quick === key}
                onClick={() => {
                  setQuick(key);
                }}
              >
                {t(`evals.quick.${key}`)}
                <span className="mk-count">{base.filter((s) => matches(s, key)).length}</span>
              </button>
            ))}
          </div>
          <select
            className="input mk-sel"
            value={agentFilter}
            onChange={(event) => {
              setAgentFilter(event.target.value);
            }}
            aria-label={t('evals.agentLabel')}
          >
            <option value="all">{t('evals.allAgents')}</option>
            {[...new Set(suites.map((s) => s.agent_id))].map((id) => (
              <option key={id} value={id}>
                {agentName(id)}
              </option>
            ))}
          </select>
        </div>
        <div className="mc-body ev-body">
          <div className="card mc-table">
            <div className="ev-tr mc-th">
              <span>{t('evals.col.suite')}</span>
              <span>{t('evals.col.kind')}</span>
              <span>{t('evals.col.score')}</span>
              <span>{t('evals.col.trend')}</span>
              <span>{t('evals.col.last')}</span>
              <span />
            </div>
            {list.map((suite) => (
              <SuiteRow
                key={suite.suite_id}
                suite={suite}
                agentName={agentName(suite.agent_id)}
                canRun={canRun(suite)}
                starting={starting === suite.suite_id}
                onOpen={() => {
                  setSelected(suite.suite_id);
                }}
                onRun={() => {
                  run(suite);
                }}
              />
            ))}
            {!list.length && <div className="mk-meta ev-nomatch">{t('evals.noMatch')}</div>}
          </div>
        </div>
      </div>
      {dialogs}
    </>
  );
}

function SuiteRow({
  suite,
  agentName,
  canRun,
  starting,
  onOpen,
  onRun,
}: {
  suite: Suite;
  agentName: string;
  canRun: boolean;
  starting: boolean;
  onOpen: () => void;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  const status = statusOf(suite);
  const delta = suite.completed_runs > 1 ? trendDelta(suite.recent_scores) : null;
  const issue = issueOf(suite.last_attempt);
  const active = suite.active_run;
  return (
    <div
      className="ev-tr"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen();
      }}
    >
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="mk-name">{suite.name}</span>
          {suite.required && (
            <span className="badge" title={t('evals.requiredTitle')}>
              {t('evals.required')}
            </span>
          )}
          {issue === 'gone' && <span className="badge badge-red">{t('evals.gone')}</span>}
        </span>
        <span className="mk-meta block">
          {t('evals.cases', { agent: agentName, count: suite.case_count })}
        </span>
      </span>
      <span className="mk-meta">{t(`evals.kind.${suite.kind}`)}</span>
      <span>
        <span className="flex items-center gap-2">
          <b
            className={`mono ev-score ${status === 'pass' ? 'ev-green' : status === 'pending' ? 'ev-muted' : 'ev-red'}`}
          >
            {status === 'pending' || !suite.last_run
              ? t('evals.notRun')
              : pct(suite.last_run.score)}
          </b>
          {delta !== null && (
            <span className={delta < 0 ? 'mk-meta mono ev-red' : 'mk-meta mono'}>
              {delta >= 0 ? '+' : ''}
              {delta}
            </span>
          )}
        </span>
        <span className="mk-meta">{t('evals.threshold', { pct: pct(suite.threshold) })}</span>
      </span>
      <EvSpark scores={suite.recent_scores} threshold={suite.threshold} />
      <span className="mk-meta">
        {active ? (
          <span className="flex items-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {t('evals.progress', { n: active.cases_done, total: active.case_count })}
          </span>
        ) : issue && issue !== 'gone' ? (
          <span className={issueTone(issue) === 'red' ? 'ev-red' : 'ev-amber'}>
            {issueLabel(t, issue)}
          </span>
        ) : suite.last_run ? (
          formatRelative(suite.last_run.finished_at)
        ) : (
          '—'
        )}
      </span>
      <span
        className="flex justify-end"
        onClick={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
        }}
      >
        {canRun && (
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon"
            title={t('evals.run')}
            aria-label={t('evals.runName', { name: suite.name })}
            disabled={Boolean(active) || starting}
            onClick={onRun}
          >
            <PlayIcon size={12} />
          </button>
        )}
      </span>
    </div>
  );
}
