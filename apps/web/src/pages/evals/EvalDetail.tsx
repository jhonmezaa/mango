import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useSession } from '../../auth/useSession';
import type { ToastTone } from '../../components/admin/useToasts';
import { Check2Icon, LockIcon, PlayIcon, WarnIcon } from '../../components/icons';
import { SidePanel } from '../../components/SidePanel';
import { formatUsd } from '../../lib/format';
import {
  MIN_THRESHOLD,
  blocks,
  caseRows,
  countedRuns,
  issueOf,
  issueTone,
  sample,
  statusOf,
  stoppedAt,
  type EvalRun,
  type Suite,
  type SuiteDetail,
} from './model';
import { EvSpark } from './parts';
import { errorText, pct, reasonText } from './text';

type Ask = 'off' | 'reject';

/** Like the API (`RemovalIn`, `RejectIn`): 1 to 500 characters. */
const REASON_MAX = 500;

/**
 * Design round 38 `.ev-why`: the reason under the settings, with its counter. «Enviar pedido» /
 * «Rechazar pedido» stay disabled without text; «Cancelar» closes. The text is shown as text.
 */
function ReasonField({
  ask,
  busy,
  onCancel,
  onSend,
}: {
  ask: Ask;
  busy: boolean;
  onCancel: () => void;
  onSend: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [why, setWhy] = useState('');
  const reason = why.trim();
  return (
    <div className="ev-why">
      <label htmlFor={id}>{t(`evals.why.${ask}.label`)}</label>
      <textarea
        id={id}
        className="input"
        rows={3}
        maxLength={REASON_MAX}
        // The field opens on a click and is what comes next (design `autoFocus`).
        autoFocus
        value={why}
        placeholder={t(`evals.why.${ask}.placeholder`)}
        onChange={(event) => {
          setWhy(event.target.value);
        }}
      />
      <div className="ev-why-f">
        <span className="mk-meta">
          {t(`evals.why.${ask}.note`)} {why.length}/{REASON_MAX}
        </span>
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
            {t('evals.why.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || !reason}
            onClick={() => {
              onSend(reason);
            }}
          >
            {t(`evals.why.${ask}.send`)}
          </button>
        </div>
      </div>
    </div>
  );
}

type Detail =
  { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; detail: SuiteDetail; runs: EvalRun[] };
type Cost = { kind: 'loading' } | { kind: 'ready'; usd: string } | { kind: 'none' };

interface Props {
  /** The row of the list: its run in progress and last attempt move with the list's polling. */
  suite: Suite;
  agentName: string;
  canRun: boolean;
  starting: boolean;
  notify: (message: string, tone?: ToastTone) => void;
  onRun: () => void;
  onChanged: () => void;
  onClose: () => void;
}

/**
 * Detail of a suite (design `EvalDetail`): the verdict and the reason of each case, never the
 * answer of the agent (the API does not return it), how and at what cost it runs, and its
 * settings for whoever edits the agent (`can_edit` of the API).
 */
export function EvalDetail({
  suite,
  agentName,
  canRun,
  starting,
  notify,
  onRun,
  onChanged,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const call = api.call;
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail>({ kind: 'loading' });
  const [cost, setCost] = useState<Cost>({ kind: 'loading' });
  const [threshold, setThreshold] = useState(suite.threshold);
  const [busy, setBusy] = useState(false);
  // Design round 38 `.ev-why`: the reason to turn «Obligatoria» off or to reject that request.
  const [ask, setAsk] = useState<Ask | null>(null);
  const openAsk = (next: Ask) => {
    setAsk(next);
  };
  const closeAsk = () => {
    setAsk(null);
  };
  const { suite_id: suiteId } = suite;
  // Read again when the suite changes (a run ends, a setting is saved): its revision moves.
  const key = `${String(suite.revision)}:${String(suite.active_run?.cases_done ?? -1)}`;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all([
      call('getEvalSuite', { path: { suite_id: suiteId } }, { signal }),
      call('getEvalRuns', { path: { suite_id: suiteId } }, { signal }),
    ]).then(
      ([read, runs]) => {
        if (!signal.aborted) setDetail({ kind: 'ready', detail: read, runs: runs.runs });
      },
      () => {
        if (!signal.aborted)
          setDetail((previous) => (previous.kind === 'ready' ? previous : { kind: 'error' }));
      },
    );
    return () => {
      controller.abort();
    };
  }, [call, suiteId, key]);

  const read = detail.kind === 'ready' ? detail.detail : null;
  const judged = read?.cases.filter((item) => item.criterion === 'judge').length ?? null;
  useEffect(() => {
    if (judged === null) return;
    const controller = new AbortController();
    call(
      'postEvalEstimate',
      {
        body: {
          agent_id: suite.agent_id,
          case_count: suite.case_count,
          judged,
          judge_model: judged ? suite.judge_model : null,
        },
      },
      { signal: controller.signal },
    ).then(
      (estimate) => {
        if (!controller.signal.aborted) setCost({ kind: 'ready', usd: estimate.usd });
      },
      () => {
        if (!controller.signal.aborted) setCost({ kind: 'none' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [call, suite.agent_id, suite.case_count, suite.judge_model, judged]);

  const status = statusOf(suite);
  const issue = issueOf(suite.last_attempt);
  const active = suite.active_run;
  const canEdit = suite.can_edit;
  const request = suite.request;
  const security = suite.kind === 'security';
  const runs = detail.kind === 'ready' ? countedRuns(detail.runs) : [];
  const last = runs[0] ?? null;
  const rows = read
    ? caseRows(read.cases, last && last.cases.length === read.cases.length ? last : null)
    : [];
  const shown = sample(rows);
  const previous = suite.recent_scores.at(-2);

  const change = (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    action()
      .then(
        () => {
          notify(done);
          onChanged();
        },
        (cause: unknown) => {
          notify(errorText(t, cause), 'error');
          onChanged();
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  const footer = canRun ? (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={Boolean(active) || starting}
        onClick={onRun}
      >
        <PlayIcon size={12} /> {active ? t('evals.detail.runningButton') : t('evals.detail.runNow')}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          onClose();
          void navigate('/playground');
        }}
      >
        {t('evals.detail.playground')}
      </button>
    </div>
  ) : undefined;

  return (
    <SidePanel
      title={suite.name}
      width={540}
      onClose={onClose}
      lead={
        <span className="mc-ic lg">
          <Check2Icon size={20} />
        </span>
      }
      meta={
        <>
          <span
            className={`badge ${status === 'pass' ? 'badge-green' : status === 'pending' ? '' : 'badge-red'}`}
          >
            {t(`evals.detail.${status}`)}
          </span>
          <span className="mk-meta">
            {agentName} · {t(`evals.kind.${suite.kind}`)}
          </span>
        </>
      }
      footer={footer}
    >
      {suite.description && <p className="ev-desc">{suite.description}</p>}
      {active && (
        <div className="mc-alert" role="status">
          <span className="spinner" aria-hidden="true" />
          <div className="flex-1">
            {t('evals.detail.running', { n: active.cases_done, total: active.case_count })}
            <span className="mk-bar-track ev-progress">
              <span
                style={{
                  width: `${String((active.cases_done / Math.max(1, active.case_count)) * 100)}%`,
                  background: 'var(--accent)',
                }}
              />
            </span>
          </div>
        </div>
      )}
      {!active && issue && suite.last_attempt && (
        <div className={`mc-alert ${issueTone(issue)}`} role="alert">
          <WarnIcon size={14} />
          <div>
            {t(`evals.issueBody.${issue}`, {
              agent: agentName,
              n: stoppedAt(suite.last_attempt),
              total: suite.last_attempt.case_count,
            })}
          </div>
        </div>
      )}
      {blocks(suite) && (
        <div className="mc-alert red">
          <LockIcon size={14} />
          <div>
            {t('evals.detail.requiredFailing', { agent: agentName, pct: pct(suite.threshold) })}
          </div>
        </div>
      )}
      <div className="ob-sum">
        <div>
          <span>{t('evals.detail.score')}</span>
          <b className="mono">{suite.last_run ? pct(suite.last_run.score) : '—'}</b>
        </div>
        <div>
          <span>{t('evals.detail.previous')}</span>
          <b className="mono">
            {suite.completed_runs > 1 && previous !== undefined ? pct(previous) : '—'}
          </b>
        </div>
        <div>
          <span>{t('evals.detail.threshold')}</span>
          <b className="mono">{pct(suite.threshold)}</b>
        </div>
        <div>
          <span>{t('evals.detail.runs')}</span>
          <b className="mono">{suite.completed_runs}</b>
        </div>
      </div>
      <section>
        <h3 className="mk-sec-t">{t('evals.detail.lastRuns')}</h3>
        <EvSpark scores={suite.recent_scores} threshold={suite.threshold} width={480} height={60} />
      </section>
      <section>
        <h3 className="mk-sec-t">
          {last
            ? t('evals.detail.casesLast', {
                ok: shown.filter((row) => row.verdict === 'ok').length,
                count: shown.length,
              })
            : t('evals.detail.cases', { count: suite.case_count })}
        </h3>
        {detail.kind === 'loading' && (
          <p className="mk-meta" role="status">
            {t('evals.detail.loading')}
          </p>
        )}
        {detail.kind === 'error' && (
          <p className="mk-meta" role="alert">
            {t('evals.detail.loadError')}
          </p>
        )}
        {shown.map((row, index) => (
          <div key={index} className="mk-line flex items-start justify-between gap-2">
            <span className="min-w-0">
              {row.question}
              {row.verdict === 'fail' && (
                <span className="mk-meta ev-why">{reasonText(t, row.reason, row.value)}</span>
              )}
            </span>
            <span
              className={`badge ${row.verdict === 'ok' ? 'badge-green' : row.verdict === 'fail' ? 'badge-red' : ''}`}
            >
              {row.verdict === 'ok'
                ? t('evals.detail.caseOk')
                : row.verdict === 'fail'
                  ? t('evals.detail.caseFail')
                  : t('evals.detail.casePending')}
            </span>
          </div>
        ))}
        {read && (
          <div className="mk-meta ev-note">
            {t('evals.detail.sampleNote', { n: shown.length, total: suite.case_count })}
          </div>
        )}
      </section>
      <section>
        <h3 className="mk-sec-t">{t('evals.detail.execution')}</h3>
        <div className="mk-kv">
          <span>{t('evals.detail.when')}</span>
          <span>{t(`evals.when.${suite.trigger}`)}</span>
        </div>
        {suite.trigger !== 'manual' && (
          <div className="mk-kv">
            <span>{t('evals.detail.runsAs')}</span>
            <span>{t('evals.detail.runsAsSubmitter')}</span>
          </div>
        )}
        <div className="mk-kv">
          <span>{t('evals.detail.cost')}</span>
          <span className="mono">
            {cost.kind === 'ready'
              ? t('evals.upTo', { usd: formatUsd(cost.usd) })
              : cost.kind === 'loading'
                ? t('evals.detail.costCalculating')
                : t('evals.detail.costUnavailable')}
          </span>
        </div>
        <div className="mk-meta ev-note">{t('evals.detail.costNote', { agent: agentName })}</div>
      </section>
      {canEdit ? (
        <section>
          <h3 className="mk-sec-t">{t('evals.detail.settings')}</h3>
          {suite.required ? (
            // Turning it off is a request with a reason (two people, D26; design round 38).
            <label className="ab-toggle">
              <input
                type="checkbox"
                checked
                disabled={busy || Boolean(request)}
                onChange={() => {
                  openAsk('off');
                }}
              />
              <span className="ab-switch" />
              <span className="flex-1">
                <span className="ev-toggle-t">{t('evals.detail.requiredToggle')}</span>
                <span className="ab-sub">{t('evals.detail.requiredSub')}</span>
              </span>
            </label>
          ) : (
            <label className="ab-toggle">
              <input
                type="checkbox"
                checked={false}
                disabled={busy || Boolean(active)}
                onChange={() => {
                  change(
                    () =>
                      call('patchEvalSuite', {
                        path: { suite_id: suiteId },
                        body: { revision: suite.revision, required: true },
                      }),
                    t('evals.toast.nowRequired'),
                  );
                }}
              />
              <span className="ab-switch" />
              <span className="flex-1">
                <span className="ev-toggle-t">{t('evals.detail.requiredToggle')}</span>
                <span className="ab-sub">{t('evals.detail.requiredSub')}</span>
              </span>
            </label>
          )}
          {request && (
            <div className="mc-alert amber ev-request">
              <LockIcon size={13} />
              <div className="flex-1">
                {t('evals.detail.request', {
                  who: request.requested_by_email ?? t('evals.detail.someone'),
                })}
                <div className="ev-request-why">
                  {t('evals.detail.requestReason', { reason: request.reason })}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  {me.is_admin && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy || request.mine}
                      title={request.mine ? t('evals.detail.approveMine') : undefined}
                      onClick={() => {
                        change(
                          () => api.approveEvalRequirement(request.change_id),
                          t('evals.toast.requestApproved'),
                        );
                      }}
                    >
                      {t('evals.detail.approve')}
                    </button>
                  )}
                  {request.mine ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={busy}
                      onClick={() => {
                        change(
                          () => api.withdrawEvalRequirement(request.change_id),
                          t('evals.toast.requestWithdrawn'),
                        );
                      }}
                    >
                      {t('evals.detail.withdraw')}
                    </button>
                  ) : (
                    me.is_admin && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={busy || ask === 'reject'}
                        onClick={() => {
                          openAsk('reject');
                        }}
                      >
                        {t('evals.detail.reject')}
                      </button>
                    )
                  )}
                </div>
              </div>
            </div>
          )}
          {ask && (
            <ReasonField
              ask={ask}
              busy={busy}
              onCancel={closeAsk}
              onSend={(reason) => {
                if (ask === 'off') {
                  change(
                    () =>
                      call('postEvalRequirementRemoval', {
                        path: { suite_id: suiteId },
                        body: { revision: suite.revision, reason },
                      }),
                    t('evals.toast.requestSent'),
                  );
                } else if (request) {
                  change(
                    () => api.rejectEvalRequirement(request.change_id, reason),
                    t('evals.toast.requestRejected'),
                  );
                }
                closeAsk();
              }}
            />
          )}
          <div className="mt-2.5 flex items-center gap-2">
            <span className="ev-small">{t('evals.detail.thresholdLabel')}</span>
            <input
              type="range"
              min={MIN_THRESHOLD}
              max={100}
              value={threshold}
              disabled={security || busy}
              aria-label={t('evals.detail.thresholdLabel')}
              className="ev-range"
              onChange={(event) => {
                setThreshold(Number(event.target.value));
              }}
            />
            <span className="mono ev-pct">{pct(threshold)}</span>
            {threshold !== suite.threshold && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || Boolean(active)}
                onClick={() => {
                  change(
                    () =>
                      call('patchEvalSuite', {
                        path: { suite_id: suiteId },
                        body: { revision: suite.revision, threshold },
                      }),
                    t('evals.toast.thresholdSaved'),
                  );
                }}
              >
                {t('evals.detail.save')}
              </button>
            )}
          </div>
        </section>
      ) : (
        <div className="mk-meta">{t('evals.detail.readOnly', { agent: agentName })}</div>
      )}
    </SidePanel>
  );
}
