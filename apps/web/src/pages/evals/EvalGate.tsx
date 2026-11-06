import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { ClockIcon, LockIcon } from '../../components/icons';
import { gateState, statusOf, type Gate, type Suite } from './model';
import { pct } from './text';

/** Design `EvalGate`: the evals section of the review of a version. */
export function EvalGate({
  gate,
  agentId,
  isNew,
  canCreate,
  contentHash,
}: {
  gate: Gate | null;
  agentId: string;
  isNew: boolean;
  canCreate: boolean;
  contentHash: string | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (isNew) {
    return (
      <div>
        <div className="mk-sec-t">{t('evals.gate.title')}</div>
        <div className="mk-meta">{t('evals.gate.newAgent')}</div>
      </div>
    );
  }
  if (!gate) return null;
  if (!gate.suites.length) {
    return (
      <div>
        <div className="mk-sec-t">{t('evals.gate.title')}</div>
        <div className="mk-meta">
          {t('evals.gate.none')}{' '}
          {canCreate && (
            <button
              type="button"
              className="sr-link"
              onClick={() => {
                void navigate('/evals', { state: { evalsCreateFor: agentId } });
              }}
            >
              {t('evals.gate.createEval')}
            </button>
          )}
        </div>
      </div>
    );
  }
  const names = (list: Suite[]) => list.map((suite) => suite.name).join(', ');
  const passing = gate.suites.filter((suite) => statusOf(suite) === 'pass').length;
  return (
    <div>
      <div className="mk-sec-t">
        {t('evals.gate.titleCount', { pass: passing, count: gate.suites.length })}
      </div>
      {gate.running.length > 0 && (
        <div className="mc-alert amber ev-gate-alert" role="status">
          <span className="spinner" aria-hidden="true" />
          <div>{t('evals.gate.running', { suites: names(gate.running) })}</div>
        </div>
      )}
      {gate.waiting.length > 0 && (
        <div className="mc-alert amber ev-gate-alert" role="status">
          <ClockIcon size={13} />
          <div>
            {t('evals.gate.waiting', { suites: names(gate.waiting), count: gate.waiting.length })}
          </div>
        </div>
      )}
      {gate.unfinished.length > 0 && (
        <div className="mc-alert amber ev-gate-alert" role="status">
          <ClockIcon size={13} />
          <div>
            {t('evals.gate.notRun', {
              suites: names(gate.unfinished),
              count: gate.unfinished.length,
            })}
          </div>
        </div>
      )}
      {gate.failing.length > 0 && (
        <div className="mc-alert red ev-gate-alert">
          <LockIcon size={13} />
          <div>
            {t('evals.gate.failing', { suites: names(gate.failing), count: gate.failing.length })}
          </div>
        </div>
      )}
      <div className="rv-tools">
        {gate.suites.map((suite) => {
          const state = gateState(suite, contentHash);
          return (
            <div
              key={suite.suite_id}
              className={statusOf(suite) === 'pass' ? 'rv-tool' : 'rv-tool ev-gate-bad'}
            >
              <span className="flex-1">
                {suite.name}
                {suite.required ? t('evals.gate.requiredTag') : ''}
              </span>
              <span className="mono">
                {suite.required && state === 'running'
                  ? t('evals.gate.rowRunning')
                  : suite.required && state === 'waiting'
                    ? t('evals.gate.rowWaiting')
                    : suite.required && state === 'not_run'
                      ? t('evals.gate.rowNotRun')
                      : `${suite.last_run ? pct(suite.last_run.score) : '—'} / ${pct(suite.threshold)}`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
