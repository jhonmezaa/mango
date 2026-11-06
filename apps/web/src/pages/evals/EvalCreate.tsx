import { useEffect, useId, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../auth/useSession';
import { CheckIcon, CloseIcon, InfoIcon, LockIcon, UploadIcon } from '../../components/icons';
import { Soon, SoonTag } from '../../components/Soon';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { formatUsd } from '../../lib/format';
import { findSecrets } from '../agentBuilder/model';
import {
  CRITERIA,
  MAX_CASES,
  MAX_CSV_BYTES,
  MAX_NAME_CHARS,
  MAX_VALUE_CHARS,
  MIN_THRESHOLD,
  caseIncomplete,
  parseCsv,
  type Kind,
  type NewCase,
} from './model';
import { errorText, type Agent } from './text';

type Step = 1 | 2 | 3 | 4;
type Trigger = 'manual' | 'on_submit';
type Cost = { kind: 'loading' } | { kind: 'ready'; usd: string } | { kind: 'none' };
type KeyedCost = { key: string; cost: Cost };
interface Draft {
  agent: string;
  kind: Kind;
  name: string;
  threshold: number;
  required: boolean;
  trigger: Trigger;
  judge: string;
  cases: NewCase[];
}

const STEPS = ['agent', 'cases', 'criteria', 'run'] as const;
const SOURCES = ['chats', 'pg', 'csv', 'ai'] as const;

interface Props {
  /** The agents the account edits (design evEdits); the API checks EditEvals on create. */
  agents: Agent[];
  initialAgent: string;
  /** `models.judges` of the installation (GET /api/evals). */
  judgeModels: string[];
  /** Names of the enabled models of the catalog. */
  modelNames: Map<string, string>;
  onClose: () => void;
  onCreated: (suiteId: string, onSubmit: boolean) => void;
}

const hasSecret = (item: NewCase) =>
  findSecrets(`${item.question} ${item.expected ?? ''} ${item.value ?? ''}`).length > 0;

/**
 * «Nueva suite de evals» (design `EvalCreate`): agent and kind → cases → criteria → threshold and
 * run. Only «Importar CSV» exists as a source today; the others are «Próximamente» (the design)
 * or locked (real conversations, D23). The CSV is read as text only, parsed here like the API
 * does, and every case is validated again by the server (REACT-FILE-001).
 */
export function EvalCreate({
  agents,
  initialAgent,
  judgeModels,
  modelNames,
  onClose,
  onCreated,
}: Props) {
  const { t } = useTranslation();
  const { api } = useSession();
  const titleId = useId();
  const ref = useFocusTrap<HTMLDivElement>(true, onClose);
  const judges = judgeModels.filter((id) => modelNames.has(id));
  const [step, setStep] = useState<Step>(1);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [csv, setCsv] = useState('');
  const [csvError, setCsvError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const [keyedCost, setCost] = useState<KeyedCost | null>(null);
  const [draft, setDraft] = useState<Draft>(() => ({
    agent: agents.some((a) => a.id === initialAgent) ? initialAgent : (agents[0]?.id ?? ''),
    kind: 'golden',
    name: '',
    threshold: 80,
    required: true,
    trigger: 'on_submit',
    judge: judges[0] ?? '',
    cases: [],
  }));
  const agent = agents.find((a) => a.id === draft.agent);
  const set = (patch: Partial<Draft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
  };
  const setCase = (index: number, patch: Partial<NewCase>) => {
    setDraft((previous) => ({
      ...previous,
      cases: previous.cases.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    }));
  };
  const judged = draft.cases.filter((item) => item.criterion === 'judge').length;
  const secrets = draft.cases.filter(hasSecret).length;

  const stepError = (() => {
    if (step === 1) return draft.name.trim() ? null : t('evals.create.err.name');
    if (step === 2) {
      if (!draft.cases.length) return t('evals.create.err.noCases');
      return secrets ? t('evals.create.err.secrets', { count: secrets }) : null;
    }
    if (step === 3) {
      if (draft.kind === 'security' && judged) return t('evals.create.err.securityJudge');
      if (draft.cases.some(caseIncomplete)) return t('evals.create.err.values');
      return judged && !draft.judge ? t('evals.create.err.judge') : null;
    }
    return null;
  })();

  // Design: «calculando…» and then the server's estimate (the agent's model and the judge's).
  // An estimate of other inputs than the ones on screen reads as «calculando…».
  const costKey = `${draft.agent}:${String(draft.cases.length)}:${String(judged)}:${draft.judge}`;
  const cost: Cost = keyedCost?.key === costKey ? keyedCost.cost : { kind: 'loading' };
  useEffect(() => {
    if (step !== 4 || !draft.cases.length) return;
    const controller = new AbortController();
    api
      .call(
        'postEvalEstimate',
        {
          body: {
            agent_id: draft.agent,
            case_count: draft.cases.length,
            judged,
            judge_model: judged ? draft.judge : null,
          },
        },
        { signal: controller.signal },
      )
      .then(
        (estimate) => {
          if (!controller.signal.aborted) {
            setCost({ key: costKey, cost: { kind: 'ready', usd: estimate.usd } });
          }
        },
        () => {
          if (!controller.signal.aborted) setCost({ key: costKey, cost: { kind: 'none' } });
        },
      );
    return () => {
      controller.abort();
    };
  }, [api, step, draft.agent, draft.cases.length, draft.judge, judged, costKey]);

  const next = () => {
    setTried(true);
    if (stepError) return;
    setTried(false);
    setStep((current) => (current < 4 ? ((current + 1) as Step) : current));
  };

  const importCsv = () => {
    const result = parseCsv(csv);
    if ('error' in result) {
      const { error } = result;
      setCsvError(
        error.code === 'csv_rows'
          ? t('evals.create.csvError.csv_rows', { rows: error.rows.join(', ') })
          : t(`evals.create.csvError.${error.code}`),
      );
      return;
    }
    setDraft((previous) => {
      const known = new Set(previous.cases.map((item) => item.question));
      const added = result.cases.filter((item) => !known.has(item.question));
      return { ...previous, cases: [...previous.cases, ...added].slice(0, MAX_CASES) };
    });
    setImported(t('evals.create.imported', { count: result.cases.length }));
    setCsv('');
  };

  const create = () => {
    setBusy(true);
    setServerError(null);
    api
      .call('postEvalSuite', {
        body: {
          agent_id: draft.agent,
          name: draft.name.trim(),
          kind: draft.kind,
          required: draft.required,
          threshold: draft.kind === 'security' ? 100 : draft.threshold,
          trigger: draft.trigger,
          judge_model: judged ? draft.judge : null,
          cases: draft.cases,
        },
      })
      .then(
        (created) => {
          onCreated(created.suite_id, draft.trigger === 'on_submit');
        },
        (cause: unknown) => {
          setServerError(errorText(t, cause));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  const tools = agent?.tools ?? [];

  return createPortal(
    <div
      className="ev-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="card ev-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="ev-modal-h">
          <div className="min-w-0">
            <h2 id={titleId} className="ev-modal-t">
              {t('evals.create.title')}
            </h2>
            <div className="ec-steps">
              {STEPS.map((key, index) => {
                const number = (index + 1) as Step;
                return (
                  <button
                    key={key}
                    type="button"
                    className={step === number ? 'is-on' : step > number ? 'is-done' : ''}
                    aria-current={step === number ? 'step' : undefined}
                    disabled={number > step}
                    onClick={() => {
                      if (number < step) setStep(number);
                    }}
                  >
                    <span>{step > number ? <CheckIcon size={9} /> : number}</span>
                    {t(`evals.create.steps.${key}`)}
                  </button>
                );
              })}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t('evals.create.close')}
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="ev-modal-b">
          {step === 1 && (
            <div className="grid gap-4">
              <div className="ev-pair">
                <div>
                  <Label htmlFor={`${titleId}-agent`}>{t('evals.create.agent')}</Label>
                  <select
                    id={`${titleId}-agent`}
                    className="input"
                    value={draft.agent}
                    onChange={(event) => {
                      set({ agent: event.target.value, cases: [] });
                    }}
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor={`${titleId}-name`}>{t('evals.create.name')}</Label>
                  <input
                    id={`${titleId}-name`}
                    className="input"
                    value={draft.name}
                    maxLength={MAX_NAME_CHARS}
                    placeholder={t('evals.create.namePlaceholder', {
                      category: agent?.category ?? '',
                    })}
                    autoFocus
                    onChange={(event) => {
                      set({ name: event.target.value });
                    }}
                  />
                </div>
              </div>
              <div>
                <Label>{t('evals.create.kind')}</Label>
                <div className="ev-kinds">
                  {(['golden', 'regression', 'human', 'security'] as const).map((key) =>
                    key === 'human' ? (
                      <Soon key={key} name={t('evals.kind.human')} block>
                        <KindCard kind={key} on={false} onPick={() => undefined} />
                      </Soon>
                    ) : (
                      <KindCard
                        key={key}
                        kind={key}
                        on={draft.kind === key}
                        onPick={() => {
                          set({
                            kind: key,
                            threshold: key === 'security' ? 100 : draft.threshold,
                            cases: [],
                          });
                        }}
                      />
                    ),
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="grid gap-3">
              <div className="tk-quick ev-sources">
                {SOURCES.map((key) => {
                  const soon = key === 'pg' || key === 'ai';
                  return (
                    <button
                      key={key}
                      type="button"
                      className={
                        key === 'csv' ? 'is-on flex items-center gap-2' : 'flex items-center gap-2'
                      }
                      aria-pressed={key === 'csv'}
                      disabled={key !== 'csv'}
                      title={
                        soon
                          ? t('evals.create.soonTitle')
                          : key === 'chats'
                            ? t('evals.create.chatsLockedTitle')
                            : undefined
                      }
                    >
                      {key === 'chats' && <LockIcon size={11} />}
                      {t(`evals.create.src.${key}`)}
                      {soon && <SoonTag />}
                    </button>
                  );
                })}
              </div>
              <div className="ec-src">
                <div className="mc-alert ev-small-alert">
                  <LockIcon size={13} />
                  <div>{t('evals.create.chatsLocked')}</div>
                </div>
                <div className="mk-meta ev-mb6">
                  {t('evals.create.csvHelp', {
                    columns: t('evals.create.csvColumns'),
                    contains: t('evals.create.csvContains'),
                  })}
                </div>
                <textarea
                  className="input mono ev-csv"
                  rows={6}
                  value={csv}
                  aria-label={t('evals.create.csvLabel')}
                  placeholder={t('evals.create.csvPlaceholder')}
                  onChange={(event) => {
                    setCsv(event.target.value);
                    setCsvError(null);
                    setImported(null);
                  }}
                />
                <div className="mt-2 flex items-center gap-2">
                  <label className="btn btn-sm ev-upload">
                    <UploadIcon size={12} /> {t('evals.create.upload')}
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      hidden
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (!file) return;
                        // Read as text only, never rendered as markup (REACT-FILE-001).
                        if (file.size > MAX_CSV_BYTES) {
                          setCsvError(t('evals.create.csvError.csv_too_large'));
                          return;
                        }
                        file.text().then(
                          (text) => {
                            setCsv(text);
                            setCsvError(null);
                          },
                          () => {
                            setCsvError(t('evals.create.csvError.csv_invalid'));
                          },
                        );
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={!csv.trim()}
                    onClick={importCsv}
                  >
                    {t('evals.create.import')}
                  </button>
                  {csvError && (
                    <span className="ev-err" role="alert">
                      {csvError}
                    </span>
                  )}
                  {imported && (
                    <span className="mk-meta" role="status">
                      {imported}
                    </span>
                  )}
                </div>
              </div>
              <div>
                <Label hint={t('evals.create.caseCount', { count: draft.cases.length })}>
                  {t('evals.create.suiteCases')}
                </Label>
                {!draft.cases.length ? (
                  <div className="mk-meta">{t('evals.create.noCases')}</div>
                ) : (
                  <div className="ec-list">
                    {draft.cases.map((item, index) => {
                      const secret = hasSecret(item);
                      return (
                        <div
                          key={`${String(index)}-${item.question}`}
                          className={secret ? 'ec-row ev-secret' : 'ec-row'}
                        >
                          <span className="mv-cap">{t('evals.create.csvTag')}</span>
                          <span className="ev-case-q">
                            {item.question}
                            {secret && (
                              <span className="ev-err block">{t('evals.create.secret')}</span>
                            )}
                          </span>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            aria-label={t('evals.create.removeCase')}
                            onClick={() => {
                              set({ cases: draft.cases.filter((_, i) => i !== index) });
                            }}
                          >
                            <CloseIcon size={12} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="grid gap-3">
              {judged > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="ev-small ev-strong" htmlFor={`${titleId}-judge`}>
                    {t('evals.create.judgeModel')}
                  </label>
                  {judges.length ? (
                    <select
                      id={`${titleId}-judge`}
                      className="input ev-auto"
                      value={draft.judge}
                      onChange={(event) => {
                        set({ judge: event.target.value });
                      }}
                    >
                      {judges.map((id) => (
                        <option key={id} value={id}>
                          {modelNames.get(id) ?? id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="ev-err">{t('evals.create.noJudges')}</span>
                  )}
                  <span className="mk-meta">
                    {t('evals.create.judgeHelp', { agent: agent?.name ?? '' })}
                  </span>
                </div>
              )}
              <div className="ec-list">
                {draft.cases.map((item, index) => (
                  <div key={`${String(index)}-${item.question}`} className="ec-crit">
                    <div className="ev-crit-q">{item.question}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        className="input ev-auto ev-small"
                        value={item.criterion}
                        aria-label={t('evals.create.criterion')}
                        onChange={(event) => {
                          setCase(index, {
                            criterion: event.target.value as NewCase['criterion'],
                            value: '',
                          });
                        }}
                      >
                        {CRITERIA.filter((c) => !(draft.kind === 'security' && c === 'judge')).map(
                          (criterion) => (
                            <option key={criterion} value={criterion}>
                              {t(`evals.create.crit.${criterion}`)}
                            </option>
                          ),
                        )}
                      </select>
                      {item.criterion === 'contains' && (
                        <input
                          className="input ev-grow ev-small"
                          value={item.value ?? ''}
                          maxLength={MAX_VALUE_CHARS}
                          aria-label={t('evals.create.containsPlaceholder')}
                          placeholder={t('evals.create.containsPlaceholder')}
                          onChange={(event) => {
                            setCase(index, { value: event.target.value });
                          }}
                        />
                      )}
                      {item.criterion === 'uses_tool' && (
                        <select
                          className="input ev-grow ev-small"
                          value={item.value ?? ''}
                          aria-label={t('evals.create.toolLabel')}
                          onChange={(event) => {
                            setCase(index, { value: event.target.value });
                          }}
                        >
                          <option value="">{t('evals.create.toolPlaceholder')}</option>
                          {(tools.includes(item.value ?? '') || !item.value
                            ? tools
                            : [item.value ?? '', ...tools]
                          ).map((tool) => (
                            <option key={tool} value={tool}>
                              {tool.split('.').slice(1).join('.') || tool}
                            </option>
                          ))}
                        </select>
                      )}
                      {item.criterion === 'judge' && (
                        <input
                          className="input ev-grow ev-small"
                          value={item.expected ?? ''}
                          aria-label={t('evals.create.expectedPlaceholder')}
                          placeholder={t('evals.create.expectedPlaceholder')}
                          onChange={(event) => {
                            setCase(index, { expected: event.target.value });
                          }}
                        />
                      )}
                      {item.criterion === 'no_disclosure' && (
                        <span className="mk-meta">{t('evals.create.noLeakHelp')}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="grid gap-4">
              <div>
                <Label hint={draft.kind === 'security' ? t('evals.create.securityHint') : null}>
                  {t('evals.create.thresholdLabel')}
                </Label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={MIN_THRESHOLD}
                    max={100}
                    value={draft.kind === 'security' ? 100 : draft.threshold}
                    disabled={draft.kind === 'security'}
                    aria-label={t('evals.create.thresholdLabel')}
                    className="ev-range"
                    onChange={(event) => {
                      set({ threshold: Number(event.target.value) });
                    }}
                  />
                  <span className="mono ev-pct">
                    {draft.kind === 'security' ? 100 : draft.threshold}%
                  </span>
                </div>
              </div>
              <label className="ab-toggle">
                <input
                  type="checkbox"
                  checked={draft.required}
                  onChange={(event) => {
                    set({ required: event.target.checked });
                  }}
                />
                <span className="ab-switch" />
                <span className="flex-1">
                  <span className="ev-toggle-t">{t('evals.create.requiredLabel')}</span>
                  <span className="ab-sub">
                    {t('evals.create.requiredSub', { agent: agent?.name ?? '' })}
                  </span>
                </span>
              </label>
              <div>
                <Label>{t('evals.create.whenLabel')}</Label>
                <div className="ab-seg">
                  {(['manual', 'on_submit'] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={draft.trigger === key ? 'is-on' : ''}
                      aria-pressed={draft.trigger === key}
                      onClick={() => {
                        set({ trigger: key });
                      }}
                    >
                      {t(`evals.when.${key}`)}
                    </button>
                  ))}
                  <Soon name={t('evals.when.schedule')}>
                    <button type="button">{t('evals.when.schedule')}</button>
                  </Soon>
                </div>
                {draft.trigger === 'on_submit' && (
                  <div className="g-hint ev-mt6">
                    {t('evals.create.runsAsSubmitter', { agent: agent?.name ?? '' })}
                  </div>
                )}
              </div>
              <div className="mc-alert">
                <InfoIcon size={14} />
                <div>
                  {t('evals.create.summary', { count: draft.cases.length })}
                  {' · '}
                  {t('evals.create.summaryJudge', {
                    count: judged,
                    judge: judged ? (modelNames.get(draft.judge) ?? draft.judge) : '—',
                  })}
                  {' · '}
                  {t('evals.create.summaryCost')}{' '}
                  {cost.kind === 'ready' ? (
                    <b className="mono">{t('evals.upTo', { usd: formatUsd(cost.usd) })}</b>
                  ) : cost.kind === 'loading' ? (
                    <span className="mk-meta">{t('evals.detail.costCalculating')}</span>
                  ) : (
                    <span className="mk-meta">{t('evals.detail.costUnavailable')}</span>
                  )}
                  . {t('evals.create.summaryNote', { agent: agent?.name ?? '' })}
                </div>
              </div>
            </div>
          )}
        </div>
        {((tried && stepError) || serverError) && (
          <div className="ev-modal-err" role="alert">
            {serverError ?? stepError}
          </div>
        )}
        <div className="ev-modal-f">
          {step > 1 && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setStep((current) => (current > 1 ? ((current - 1) as Step) : current));
              }}
            >
              {t('evals.create.back')}
            </button>
          )}
          <div className="flex-1" />
          <button type="button" className="btn btn-sm" onClick={onClose}>
            {t('evals.create.cancel')}
          </button>
          {step < 4 ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={next}>
              {t('evals.create.next')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={create}
            >
              {t('evals.create.submit')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Label({
  children,
  hint,
  htmlFor,
}: {
  children: ReactNode;
  hint?: string | null;
  htmlFor?: string;
}) {
  return (
    <div className="ev-lb">
      {htmlFor ? <label htmlFor={htmlFor}>{children}</label> : <span>{children}</span>}
      {hint && <span className="mk-meta">{hint}</span>}
    </div>
  );
}

function KindCard({ kind, on, onPick }: { kind: Kind | 'human'; on: boolean; onPick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={on ? 'ab-model is-on ev-kind' : 'ab-model ev-kind'}
      aria-pressed={on}
      onClick={onPick}
    >
      <span className="ab-radio ev-radio" />
      <span>
        <span className="ev-toggle-t">{t(`evals.kind.${kind}`)}</span>
        <span className="mk-meta">{t(`evals.kindDesc.${kind}`)}</span>
      </span>
    </button>
  );
}
