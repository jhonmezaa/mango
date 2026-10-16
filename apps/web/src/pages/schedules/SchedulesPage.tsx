import type { TFunction } from 'i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { ApiError } from '../../api/errors';
import type { OperationCaller } from '../../api/operations';
import { useSession } from '../../auth/useSession';
import { ChatMarkdown } from '../../components/ChatMarkdown';
import { GovErrorState, GovModal, Skel } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import {
  ArchiveIcon,
  ChevronLeftIcon,
  ClockIcon,
  EditIcon,
  InfoIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  UserIcon,
  WarnIcon,
  ZapIcon,
} from '../../components/icons';
import { SidePanel } from '../../components/SidePanel';
import { Soon } from '../../components/Soon';
import { Topbar } from '../../components/Topbar';
import { formatRelative, formatUsd } from '../../lib/format';
import {
  DAYS,
  FREQUENCIES,
  QUICK,
  RUN_TONE,
  TIMEZONES,
  autoPauseKind,
  cronOf,
  durationMs,
  healthOf,
  isEvent,
  isOpen,
  isRunReason,
  matchesQuick,
  monthlyEstimate,
  needsAttention,
  pad2,
  permsOf,
  startedToday,
  utcDay,
  type Frequency,
  type Health,
  type Perms,
  type QuickFilter,
  type RunDetail,
  type Spec,
  type Task,
  type TaskList,
  type TaskRun,
  type TimeZone,
} from './model';

type Agent = { id: string; name: string; status: string; unavailable_tools: string[] };
type LoadState =
  { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; list: TaskList; agents: Agent[] };
type Translate = TFunction;

/** Someone else (or a run) may change a task while the page is open. */
const POLL_MS = 20_000;
/** While a run is queued or running, its end is looked for this often. */
const RUN_POLL_MS = 3_000;
/** Design: the editor asks for the next runs 300 ms after the last change. */
const PREVIEW_DELAY_MS = 300;
/** Design: the toast of a finished run stays 8 s, with its button. */
const DONE_TOAST_MS = 8000;
const TONE_COLOR = {
  green: 'var(--green)',
  red: 'var(--red)',
  dim: 'var(--text-dim)',
  amber: 'var(--amber)',
  muted: 'var(--text-muted)',
} as const;
const STATUS_BADGE = { active: 'badge-green', paused: '', retired: '' } as const;
const DEFAULT_SPEC: Spec = { freq: 'daily', hour: 9, minute: 0, days: [1, 4], dow: 1, dom: 1 };
const FMT = new Intl.DateTimeFormat('es-MX', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const TIME = new Intl.DateTimeFormat('es-MX', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const DAY_UTC = new Intl.DateTimeFormat('es-MX', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

function dayName(t: Translate, day: number): string {
  switch (day) {
    case 1:
      return t('schedules.dow.mon');
    case 2:
      return t('schedules.dow.tue');
    case 3:
      return t('schedules.dow.wed');
    case 4:
      return t('schedules.dow.thu');
    case 5:
      return t('schedules.dow.fri');
    case 6:
      return t('schedules.dow.sat');
    default:
      return t('schedules.dow.sun');
  }
}

/** Design scLabel. */
function specLabel(t: Translate, spec: Spec): string {
  const time = `${pad2(spec.hour)}:${pad2(spec.minute)}`;
  switch (spec.freq) {
    case '15m':
      return t('schedules.label.15m');
    case 'hourly':
      return t('schedules.label.hourly', { min: spec.minute });
    case '6h':
      return t('schedules.label.6h');
    case 'daily':
      return t('schedules.label.daily', { time });
    case 'weekdays':
      return t('schedules.label.weekdays', { time });
    case 'weekly':
      return t('schedules.label.weekly', { day: dayName(t, spec.dow), time });
    case 'monthly':
      return t('schedules.label.monthly', { dom: spec.dom, time });
    case 'days': {
      const names = spec.days.map((day) => dayName(t, day));
      const joined =
        names.length > 1
          ? `${names.slice(0, -1).join(', ')}${t('schedules.and')}${names.at(-1) ?? ''}`
          : (names[0] ?? '');
      return t('schedules.label.days', {
        days: joined.replace(/^./, (c) => c.toUpperCase()),
        time,
      });
    }
  }
}

/** Design scReason: a fixed text for each code; an unknown code says it could not finish. */
function runReason(t: Translate, reason: string | null): string | null {
  if (!reason) return null;
  return isRunReason(reason)
    ? t(`schedules.run.reason.${reason}`)
    : t('schedules.run.unknownReason');
}

/** Design scRange: the dates of an anomaly, as AWS gives them (UTC days). */
function anomalyDates(anomaly: NonNullable<TaskRun['anomaly']>): string {
  const from = new Date(`${anomaly.start}T00:00:00Z`);
  const to = new Date(`${anomaly.end}T00:00:00Z`);
  const a = DAY_UTC.format(from);
  const b = DAY_UTC.format(to);
  if (a === b) return b;
  return from.getUTCMonth() === to.getUTCMonth() ? `${from.getUTCDate()}–${b}` : `${a} – ${b}`;
}

function triggerLabel(t: Translate, task: Task): string {
  if (isEvent(task)) return t('schedules.event.label');
  return task.trigger.schedule ? specLabel(t, task.trigger.schedule) : '—';
}

function ownerName(task: Task): string {
  return task.owner.name ?? task.owner.email ?? task.owner.user_id;
}

function zoneLabel(t: Translate, zone: TimeZone): string {
  return zone === 'UTC'
    ? t('schedules.editor.upcomingUtc')
    : t('schedules.editor.upcomingZone', { name: t(`schedules.zone.${zone}`) });
}

function healthText(t: Translate, task: Task, health: Health): string {
  const owner = ownerName(task);
  switch (health.key) {
    case 'agent_unavailable':
      return t('schedules.health.agent_unavailable');
    case 'access_lost':
      return t('schedules.health.access_lost', {
        reason:
          autoPauseKind(task) === 'central'
            ? t('schedules.detail.centralReason', { owner })
            : t('schedules.detail.lostReason', { owner }),
      });
    case 'failing':
      return t('schedules.health.failing');
    case 'tools':
      return t('schedules.health.tools', { tools: health.values?.tools ?? '' });
  }
}

function errorToast(t: Translate, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'task_limit') return t('schedules.toast.limit');
    if (error.code === 'secret_in_task') return t('schedules.editor.errSecret');
    if (error.code === 'central_only') return t('schedules.editor.centralOnly');
    if (error.status === 429) return t('schedules.toast.rateLimited');
  }
  return t('schedules.toast.error');
}

function statusBadge(t: Translate, task: Task): [string, string] {
  if (task.status === 'paused' && task.paused_reason === 'admin') {
    return [t('schedules.status.adminPaused'), 'badge-amber'];
  }
  return [t(`schedules.status.${task.status}`), STATUS_BADGE[task.status]];
}

function RunDots({ task }: { task: Task }) {
  const { t } = useTranslation();
  if (task.runs.length === 0) return <span className="mk-meta">{t('schedules.noRuns')}</span>;
  return (
    <span className="sc-dots" aria-label={t('schedules.runsLabel')}>
      {task.runs
        .slice(0, 10)
        .toReversed()
        .map((run) => {
          const reason = runReason(t, run.reason);
          return (
            <i
              key={run.run_id}
              title={`${t(`schedules.run.${run.status}`)}${reason ? ` · ${reason}` : ''} · ${FMT.format(new Date(run.queued_at))}`}
              style={{ background: TONE_COLOR[RUN_TONE[run.status] ?? 'dim'] }}
            />
          );
        })}
    </span>
  );
}

interface RowProps {
  task: Task;
  perms: Perms;
  agentName: string;
  health: Health | null;
  busy: boolean;
  onOpen: (task: Task, ask?: 'pause') => void;
  onRun: (task: Task) => void;
  onPause: (task: Task) => void;
  onResume: (task: Task) => void;
}

function TaskRow({
  task,
  perms,
  agentName,
  health,
  busy,
  onOpen,
  onRun,
  onPause,
  onResume,
}: RowProps) {
  const { t } = useTranslation();
  const next = task.status === 'active' ? task.next_runs[0] : undefined;
  const cap = task.trigger.daily_cap ?? 0;
  const capHit = perms.anomaly && task.status === 'active' && cap > 0 && startedToday(task) >= cap;
  const [badge, badgeClass] = statusBadge(t, task);
  return (
    <div
      className="sc-tr"
      role="button"
      tabIndex={0}
      onClick={() => {
        onOpen(task);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen(task);
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span className="mk-name" style={{ display: 'block' }}>
          {task.name}
        </span>
        <span className="mk-meta sc-ellipsis">
          {t('schedules.rowMeta', {
            agent: agentName,
            owner: perms.own ? t('schedules.you') : ownerName(task),
          })}
        </span>
      </span>
      <span style={{ fontSize: 13, minWidth: 0 }}>
        {perms.anomaly ? (
          <>
            <span className="sc-trg">
              <ZapIcon size={12} /> {t('schedules.event.label')}
            </span>
            <span className="mk-meta" style={{ display: 'block' }}>
              {t('schedules.event.capShort', { count: cap })}
            </span>
          </>
        ) : (
          <>
            {triggerLabel(t, task)}
            <span className="mk-meta" style={{ display: 'block' }}>
              {task.trigger.timezone}
            </span>
          </>
        )}
      </span>
      <span className="mk-meta">
        {perms.busy ? (
          <span className="flex items-center gap-2">
            {perms.busy.status === 'running' ? (
              <>
                <span className="g-spin" /> {t('schedules.running')}
              </>
            ) : (
              t('schedules.queuedShort')
            )}
          </span>
        ) : capHit ? (
          t('schedules.capHit')
        ) : next ? (
          FMT.format(new Date(next))
        ) : (
          '—'
        )}
      </span>
      <RunDots task={task} />
      <span className="flex items-center gap-1" style={{ flexWrap: 'wrap' }}>
        <span className={`badge ${badgeClass}`}>{badge}</span>
        {health ? (
          <span
            className={`badge ${health.tone === 'red' ? 'badge-red' : 'badge-amber'}`}
            title={healthText(t, task, health)}
          >
            <WarnIcon size={10} />
          </span>
        ) : null}
      </span>
      {/* The buttons do not open the detail. */}
      <span
        className="flex items-center gap-1"
        style={{ justifyContent: 'flex-end' }}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {perms.canRun && task.status !== 'paused' ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon"
            title={t('schedules.runNow')}
            aria-label={t('schedules.runNowOf', { name: task.name })}
            disabled={Boolean(perms.busy) || busy}
            onClick={() => {
              onRun(task);
            }}
          >
            <PlayIcon size={12} />
          </button>
        ) : null}
        {perms.canResume ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon"
            title={t('schedules.resume')}
            aria-label={t('schedules.resumeOf', { name: task.name })}
            disabled={busy}
            onClick={() => {
              onResume(task);
            }}
          >
            <PlayIcon size={12} />
          </button>
        ) : perms.canPause ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon"
            title={t('schedules.pause')}
            aria-label={t('schedules.pauseOf', { name: task.name })}
            disabled={busy}
            onClick={() => {
              // An administrator says why (D82 (2)): in the detail, as the design does.
              if (perms.own) onPause(task);
              else onOpen(task, 'pause');
            }}
          >
            <PauseIcon size={12} />
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** Design ScRunRow. */
function RunLine({
  run,
  event,
  canSee,
  onResult,
  onApproval,
}: {
  run: TaskRun;
  event: boolean;
  canSee: boolean;
  onResult: (run: TaskRun) => void;
  onApproval: (id: string) => void;
}) {
  const { t } = useTranslation();
  const ms = durationMs(run);
  const reason = runReason(t, run.reason);
  const approval = run.approvals[0];
  const waited =
    run.waiting_since && run.started_at
      ? Math.round(
          (new Date(run.started_at).getTime() - new Date(run.waiting_since).getTime()) / 60_000,
        )
      : 0;
  const result = canSee && run.has_result;
  return (
    <div className="mk-line sc-run">
      {run.status === 'running' ? (
        <span className="g-spin" aria-hidden="true" />
      ) : (
        <span
          className="tk-dot"
          aria-hidden="true"
          style={{ background: TONE_COLOR[RUN_TONE[run.status] ?? 'dim'] }}
        />
      )}
      <div className="sc-run-b">
        <span>
          {t(`schedules.run.${run.status}`)}
          {run.trigger === 'manual' ? t('schedules.run.manual') : ''}
        </span>
        {run.anomaly ? (
          <span className="mk-meta">
            {t('schedules.run.anomaly', { dates: anomalyDates(run.anomaly) })}
          </span>
        ) : null}
        {reason ? (
          <span
            className="mk-meta"
            style={run.status === 'failed' ? { color: 'var(--red)' } : undefined}
          >
            {reason}
          </span>
        ) : null}
        {run.status === 'queued' && event && run.waiting_since ? (
          <span className="mk-meta">{t('schedules.run.waiting')}</span>
        ) : null}
        {waited > 0 ? (
          <span className="mk-meta">{t('schedules.run.waited', { count: waited })}</span>
        ) : null}
        {result || (run.status === 'approval' && approval) ? (
          <span className="sc-run-acts">
            {result ? (
              <button
                type="button"
                className="sr-link"
                onClick={() => {
                  onResult(run);
                }}
              >
                {t('schedules.run.seeResult')}
              </button>
            ) : null}
            {run.status === 'approval' && approval ? (
              <button
                type="button"
                className="sr-link"
                onClick={() => {
                  onApproval(approval);
                }}
              >
                {t('schedules.run.seeApproval')}
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      <span className="mk-meta mono sc-run-m">
        {formatRelative(run.queued_at)}
        <br />
        {ms !== null
          ? t('schedules.run.meta', {
              seconds: (ms / 1000).toFixed(1).replace('.', ','),
              cost: run.cost_usd ? formatUsd(run.cost_usd) : '—',
            })
          : '—'}
      </span>
    </div>
  );
}

/** Design ScResult: the result inside the panel of the task, only for its owner (D78 (18)). */
function RunResult({
  api,
  task,
  run,
  agentName,
  onBack,
}: {
  api: OperationCaller;
  task: Task;
  run: TaskRun;
  agentName: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<RunDetail | 'error' | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api(
      'getTaskRun',
      { path: { task_id: task.task_id, run_id: run.run_id } },
      { signal: controller.signal },
    ).then(
      (found) => {
        if (!controller.signal.aborted) setDetail(found);
      },
      () => {
        if (!controller.signal.aborted) setDetail('error');
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, task.task_id, run.run_id]);
  const ms = durationMs(run);
  const meta = [
    agentName,
    t(`schedules.run.${run.status}`) + (run.trigger === 'manual' ? t('schedules.run.manual') : ''),
    ms !== null ? `${(ms / 1000).toFixed(1).replace('.', ',')} s` : null,
    run.cost_usd ? formatUsd(run.cost_usd) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="sc-res">
      <button type="button" className="sr-link sc-res-back" onClick={onBack}>
        <ChevronLeftIcon size={12} /> {t('schedules.result.back')}
      </button>
      <div>
        <div className="sc-res-h">
          {t('schedules.result.title', { when: FMT.format(new Date(run.queued_at)) })}
        </div>
        <div className="mk-meta" style={{ marginTop: 3 }}>
          {meta}
        </div>
      </div>
      {run.anomaly ? (
        <div className="sc-anom">
          <span className="mk-sec-t">{t('schedules.result.anomaly')}</span>
          <span className="mk-meta">{anomalyDates(run.anomaly)}</span>
        </div>
      ) : null}
      {detail === null ? (
        <div role="status" aria-label={t('schedules.result.loading')}>
          <Skel w="70%" h={13} />
          <Skel w="90%" h={11} />
        </div>
      ) : detail === 'error' ? (
        <div className="sc-err" role="alert">
          {t('schedules.result.error')}
        </div>
      ) : (
        <>
          {detail.steps.length > 0 ? (
            <details className="sc-steps">
              <summary>{t('schedules.result.steps', { count: detail.steps.length })}</summary>
              <ol>
                {detail.steps.map((step, index) => (
                  <li key={index}>
                    {step.text ? <span>{step.text}</span> : null}
                    {step.tool ? <span className="mk-meta mono">{step.tool}</span> : null}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {detail.result ? (
            // The agent's answer: Markdown without raw HTML (AGENTS.md, REACT-MARKUP-001).
            <div className="md">
              <ChatMarkdown>{detail.result}</ChatMarkdown>
            </div>
          ) : (
            <div className="mk-meta">{t('schedules.result.none')}</div>
          )}
        </>
      )}
      <p className="mk-meta sc-res-foot">
        <LockIcon size={11} /> {t('schedules.result.foot')}
      </p>
    </div>
  );
}

interface DetailProps {
  api: OperationCaller;
  task: Task;
  isAdmin: boolean;
  agentName: string;
  health: Health | null;
  busy: boolean;
  ask0: 'pause' | null;
  run0: string | null;
  onClose: () => void;
  onEdit: () => void;
  onRun: () => void;
  onPause: (reason: string | null) => void;
  onResume: () => void;
  onRetire: (reason: string) => void;
}

function TaskDetail({
  api,
  task,
  isAdmin,
  agentName,
  health,
  busy,
  ask0,
  run0,
  onClose,
  onEdit,
  onRun,
  onPause,
  onResume,
  onRetire,
}: DetailProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const perms = permsOf(task, isAdmin);
  const [ask, setAsk] = useState<'pause' | 'retire' | null>(ask0);
  const [why, setWhy] = useState('');
  const [runId, setRunId] = useState<string | null>(run0);
  const owner = ownerName(task);
  const spec = task.trigger.schedule;
  const ok = task.runs.filter((run) => run.status === 'ok').length;
  const openRun = runId && perms.own ? task.runs.find((run) => run.run_id === runId) : undefined;
  const cap = task.trigger.daily_cap ?? 0;
  const today = perms.anomaly ? startedToday(task) : 0;
  const kind = autoPauseKind(task);
  const pausedBy = task.paused_by ?? t('schedules.detail.adminPausedSomeone');

  const footer =
    !openRun && (perms.own || isAdmin) && task.status !== 'retired' ? (
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
        {ask ? (
          <>
            {ask === 'pause' ? (
              <span className="ap-reason" style={{ flexBasis: '100%' }}>
                <InfoIcon size={12} />
                <span>{t('schedules.detail.holdNote')}</span>
              </span>
            ) : null}
            <input
              className="input"
              style={{ flex: '1 1 200px' }}
              value={why}
              maxLength={200}
              autoFocus
              onChange={(event) => {
                setWhy(event.target.value);
              }}
              placeholder={
                ask === 'retire'
                  ? t('schedules.detail.retireReason')
                  : t('schedules.detail.pauseReason')
              }
              aria-label={
                ask === 'retire'
                  ? t('schedules.detail.retireReasonLabel')
                  : t('schedules.detail.pauseReasonLabel')
              }
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setAsk(null);
              }}
            >
              {t('schedules.detail.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!why.trim() || busy}
              onClick={() => {
                const reason = why.trim();
                const which = ask;
                setAsk(null);
                setWhy('');
                if (which === 'retire') onRetire(reason);
                else onPause(reason);
              }}
            >
              {ask === 'retire' ? (
                <>
                  <ArchiveIcon size={12} /> {t('schedules.detail.retire')}
                </>
              ) : (
                <>
                  <PauseIcon size={12} /> {t('schedules.pause')}
                </>
              )}
            </button>
          </>
        ) : (
          <>
            {perms.own && !perms.anomaly ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={Boolean(perms.busy) || !perms.canRun || busy}
                onClick={onRun}
              >
                <PlayIcon size={12} />{' '}
                {perms.busy
                  ? perms.busy.status === 'running'
                    ? t('schedules.running')
                    : t('schedules.queuedBusy')
                  : t('schedules.runNow')}
              </button>
            ) : null}
            {perms.canResume ? (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={onResume}>
                {t('schedules.resume')}
              </button>
            ) : perms.own && task.status === 'paused' ? (
              <button type="button" className="btn btn-sm" disabled>
                {t('schedules.resume')}
              </button>
            ) : null}
            {perms.canPause ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                title={perms.own ? undefined : t('schedules.detail.holdTitle')}
                onClick={() => {
                  if (perms.own) onPause(null);
                  else setAsk('pause');
                }}
              >
                <PauseIcon size={12} /> {t('schedules.pause')}
              </button>
            ) : null}
            {perms.own ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={perms.autoPaused || busy}
                onClick={onEdit}
              >
                <EditIcon size={12} /> {t('schedules.detail.edit')}
              </button>
            ) : null}
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setAsk('retire');
              }}
            >
              <ArchiveIcon size={12} /> {t('schedules.detail.retire')}
            </button>
            {perms.own && perms.adminPaused ? (
              <span className="ap-reason" style={{ flexBasis: '100%', order: 9 }}>
                <LockIcon size={12} />
                <span>{t('schedules.detail.adminPausedNote')}</span>
              </span>
            ) : null}
            {!perms.own ? (
              <span className="ap-reason" style={{ flexBasis: '100%', order: 9 }}>
                <LockIcon size={12} />
                <span>
                  {perms.anomaly
                    ? t('schedules.detail.ownerOnlyAnomaly', { owner })
                    : t('schedules.detail.ownerOnly', { owner })}
                </span>
              </span>
            ) : null}
          </>
        )}
      </div>
    ) : undefined;

  return (
    <SidePanel
      title={task.name}
      width={openRun ? 640 : 520}
      lead={
        <span className="mc-ic lg">
          {perms.anomaly ? <ZapIcon size={20} /> : <ClockIcon size={20} />}
        </span>
      }
      meta={<span className="mk-meta">{`${agentName} · ${triggerLabel(t, task)}`}</span>}
      onClose={onClose}
      onEscape={
        openRun
          ? () => {
              setRunId(null);
            }
          : onClose
      }
      footer={footer}
    >
      {openRun ? (
        <RunResult
          key={openRun.run_id}
          api={api}
          task={task}
          run={openRun}
          agentName={agentName}
          onBack={() => {
            setRunId(null);
          }}
        />
      ) : (
        <>
          {health && !perms.autoPaused ? (
            <div className={`mc-alert ${health.tone}`}>
              <WarnIcon size={14} />
              <div>{healthText(t, task, health)}.</div>
            </div>
          ) : null}
          {task.status === 'paused' && !perms.autoPaused ? (
            perms.adminPaused ? (
              <div className="mc-alert amber">
                <PauseIcon size={14} />
                <div>
                  <b>
                    {t('schedules.detail.adminPausedBy', {
                      by: isAdmin ? pausedBy : t('schedules.detail.adminPausedSomeone'),
                    })}
                  </b>{' '}
                  {t('schedules.detail.adminPausedBody')}
                  {task.paused_note ? (
                    <div style={{ marginTop: 4 }}>
                      {t('schedules.detail.adminPausedReason', { reason: task.paused_note })}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="mc-alert">
                <PauseIcon size={14} />
                <div>
                  {perms.own
                    ? t('schedules.detail.paused')
                    : t('schedules.detail.pausedByOwner', { owner })}
                </div>
              </div>
            )
          ) : null}
          {perms.autoPaused && task.status === 'paused' && task.paused_at ? (
            <div className="mc-alert red">
              <LockIcon size={14} />
              <div>
                <b>
                  {t('schedules.detail.autoPausedTitle', { ago: formatRelative(task.paused_at) })}
                </b>{' '}
                {kind === 'central'
                  ? t('schedules.detail.centralReason', { owner })
                  : t('schedules.detail.lostReason', { owner })}
                .{' '}
                {kind === 'central'
                  ? t('schedules.detail.autoPausedCentral')
                  : t('schedules.detail.autoPausedAccess')}
              </div>
            </div>
          ) : null}
          {task.retired ? (
            <div className="mc-alert">
              <ArchiveIcon size={14} />
              <div>
                {t('schedules.detail.retired', {
                  by: task.retired.by ?? '—',
                  reason: task.retired.reason ? ` · ${task.retired.reason}` : '',
                })}
              </div>
            </div>
          ) : null}
          <section className="mk-sec">
            <h3 className="mk-sec-t">{t('schedules.detail.task').toLowerCase()}</h3>
            {perms.own && task.task !== null ? (
              <div className="sc-task">{task.task}</div>
            ) : (
              <div className="ap-reason">
                <LockIcon size={12} />
                <span>{t('schedules.detail.taskHidden', { owner })}</span>
              </div>
            )}
          </section>
          {perms.anomaly ? (
            <section className="mk-sec">
              <h3 className="mk-sec-t">{t('schedules.detail.trigger').toLowerCase()}</h3>
              <div className="mk-kv">
                <span>{t('schedules.detail.starts')}</span>
                <span>{t('schedules.event.label')}</span>
              </div>
              <div className="mk-kv">
                <span>{t('schedules.detail.cap')}</span>
                <span>{t('schedules.event.cap', { count: cap })}</span>
              </div>
              <div className="mk-kv">
                <span>{t('schedules.detail.today')}</span>
                <span
                  style={{
                    textAlign: 'right',
                    ...(cap > 0 && today >= cap ? { color: 'var(--amber)' } : {}),
                  }}
                >
                  {t('schedules.detail.todayValue', {
                    count: today,
                    cap,
                    time: TIME.format(new Date(utcDay(1))),
                  })}
                </span>
              </div>
              <div className="mk-kv">
                <span>{t('schedules.detail.several')}</span>
                <span style={{ textAlign: 'right' }}>{t('schedules.detail.severalValue')}</span>
              </div>
            </section>
          ) : spec ? (
            <section className="mk-sec">
              <h3 className="mk-sec-t">{t('schedules.detail.schedule').toLowerCase()}</h3>
              <div className="mk-kv">
                <span>{t('schedules.detail.frequency')}</span>
                <span>{specLabel(t, spec)}</span>
              </div>
              <div className="mk-kv">
                <span>{t('schedules.detail.timezone')}</span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {task.trigger.timezone}
                </span>
              </div>
              <div className="mk-kv">
                <span>{t('schedules.detail.cron')}</span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {cronOf(spec)}
                </span>
              </div>
              {task.status === 'active' && task.next_runs.length > 0 ? (
                <div className="mk-kv">
                  <span>{t('schedules.detail.upcoming')}</span>
                  <span style={{ textAlign: 'right' }}>
                    {task.next_runs.map((at) => (
                      <div key={at}>{FMT.format(new Date(at))}</div>
                    ))}
                  </span>
                </div>
              ) : null}
            </section>
          ) : null}
          <section className="mk-sec">
            <h3 className="mk-sec-t">{t('schedules.detail.control').toLowerCase()}</h3>
            <div className="mk-kv">
              <span>{t('schedules.detail.result')}</span>
              <span style={{ textAlign: 'right' }}>
                {perms.own
                  ? t('schedules.detail.resultValueMine')
                  : t('schedules.detail.resultValueOther', { owner })}
              </span>
            </div>
            <div className="mk-kv">
              <span>{t('schedules.detail.runsAs')}</span>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere', textAlign: 'right' }}>
                {t('schedules.detail.runsAsValue', { owner })}
              </span>
            </div>
            <div className="mk-kv">
              <span>{t('schedules.detail.agent')}</span>
              <span>{t('schedules.detail.agentValue', { agent: agentName })}</span>
            </div>
            <div className="mk-kv">
              {/* An owner without a name shows their address, which has no spaces to wrap at. */}
              <span style={{ minWidth: 0, flexShrink: 1, overflowWrap: 'anywhere' }}>
                {perms.anomaly
                  ? t('schedules.detail.ifLostCentral', { owner })
                  : t('schedules.detail.ifLost', { owner })}
              </span>
              <span>{t('schedules.detail.ifLostValue')}</span>
            </div>
            <div className="mk-kv">
              <span>{t('schedules.detail.writes')}</span>
              <span>{t('schedules.detail.writesValue')}</span>
            </div>
          </section>
          <section className="mk-sec">
            <h3 className="mk-sec-t">
              {t('schedules.detail.recent', { ok, total: task.runs.length }).toLowerCase()}
            </h3>
            {!perms.own && task.runs.length > 0 ? (
              <p className="mk-meta" style={{ margin: '0 0 4px' }}>
                {t('schedules.detail.resultsOwnerOnly', { owner })}
              </p>
            ) : null}
            {task.runs.length > 0 ? (
              task.runs.map((run) => (
                <RunLine
                  key={run.run_id}
                  run={run}
                  event={perms.anomaly}
                  canSee={perms.own}
                  onResult={(item) => {
                    setRunId(item.run_id);
                  }}
                  onApproval={(id) => {
                    onClose();
                    void navigate(`/approvals/pending/${id}`);
                  }}
                />
              ))
            ) : (
              <div className="mk-meta">{t('schedules.detail.noRuns')}</div>
            )}
          </section>
        </>
      )}
    </SidePanel>
  );
}

interface Draft {
  name: string;
  agent: string;
  task: string;
  kind: 'schedule' | 'event';
  spec: Spec;
  tz: TimeZone;
}

function draftOf(task: Task | null, agents: Agent[]): Draft {
  if (!task) {
    return {
      name: '',
      agent: agents[0]?.id ?? '',
      task: '',
      kind: 'schedule',
      spec: DEFAULT_SPEC,
      tz: TIMEZONES[0],
    };
  }
  const tz = TIMEZONES.find((zone) => zone === task.trigger.timezone) ?? TIMEZONES[0];
  return {
    name: task.name,
    agent: task.agent_id,
    task: task.task ?? '',
    kind: isEvent(task) ? 'event' : 'schedule',
    spec: { ...DEFAULT_SPEC, ...task.trigger.schedule },
    tz,
  };
}

/** The offset of a time zone from the viewer's, now, in minutes (design scTzOff). */
function zoneOffset(zone: TimeZone): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
  );
  return Math.round((asUtc - Math.floor(Date.now() / 60_000) * 60_000) / 60_000);
}

/** Design 2.5: the next runs in the zone of the task, computed by the server 300 ms after the
 * last change; «Calculando…» meanwhile, nothing if it fails. */
function useNextRuns(api: OperationCaller, draft: Draft): string[] | 'computing' | null {
  const [found, setFound] = useState<{ key: string; next: string[] | null } | null>(null);
  const applies =
    draft.kind === 'schedule' && !(draft.spec.freq === 'days' && draft.spec.days.length === 0);
  const key = JSON.stringify([draft.spec, draft.tz]);
  const { spec, tz } = draft;
  useEffect(() => {
    if (!applies) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api(
        'previewNextRuns',
        { body: { schedule: spec, timezone: tz } },
        { signal: controller.signal },
      ).then(
        (answer) => {
          if (!controller.signal.aborted) setFound({ key, next: answer.next_runs });
        },
        () => {
          if (!controller.signal.aborted) setFound({ key, next: null });
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `key` stands for `spec` and `tz`: a new object with the same values asks nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, applies, key]);
  if (!applies) return null;
  return found?.key === key ? found.next : 'computing';
}

function TaskEditor({
  api,
  task,
  agents,
  allAgents,
  canSubscribeEvents,
  onClose,
  onSaved,
}: {
  api: OperationCaller;
  task: Task | null;
  agents: Agent[];
  allAgents: ReadonlyMap<string, Agent>;
  canSubscribeEvents: boolean;
  onClose: () => void;
  onSaved: (saved: Task, created: boolean) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() => draftOf(task, agents));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const isNew = task === null;
  const anomaly = draft.kind === 'event';
  // Design: the agent of a task stays in the list while editing even if it is no longer usable.
  const options = useMemo(() => {
    const current = !isNew ? allAgents.get(draft.agent) : undefined;
    return current && !agents.some((agent) => agent.id === current.id)
      ? [current, ...agents]
      : agents;
  }, [agents, allAgents, draft.agent, isNew]);
  const agentName = options.find((agent) => agent.id === draft.agent)?.name;
  const next = useNextRuns(api, draft);
  const setSpec = (patch: Partial<Spec>) => {
    setDraft((current) => ({ ...current, spec: { ...current.spec, ...patch } }));
  };
  const noDays = !anomaly && draft.spec.freq === 'days' && draft.spec.days.length === 0;
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push(t('schedules.editor.errName'));
  if (!draft.agent) errors.push(t('schedules.editor.errAgent'));
  if (!draft.task.trim()) errors.push(t('schedules.editor.errTask'));
  if (noDays) errors.push(t('schedules.editor.errDays'));
  const heavy = !anomaly && (draft.spec.freq === '15m' || draft.spec.freq === 'hourly');
  const otherZone = !anomaly && zoneOffset(draft.tz) !== -new Date().getTimezoneOffset();

  const save = () => {
    setTried(true);
    if (errors.length > 0 || busy) return;
    setBusy(true);
    setFailure(null);
    const trigger = anomaly
      ? { kind: 'event' as const, event_type: 'cost_anomaly' as const }
      : { kind: 'schedule' as const, schedule: draft.spec, timezone: draft.tz };
    const body = {
      name: draft.name.trim(),
      agent_id: draft.agent,
      task: draft.task.trim(),
      trigger,
      deliver: 'inbox' as const,
    };
    const request = isNew
      ? api('createNewTask', { body })
      : api('updateExistingTask', { path: { task_id: task.task_id }, body });
    request.then(
      (saved) => {
        onSaved(saved, isNew);
      },
      (error: unknown) => {
        setBusy(false);
        setFailure(errorToast(t, error));
      },
    );
  };

  return (
    <GovModal
      title={
        isNew
          ? t('schedules.editor.newTitle')
          : t('schedules.editor.editTitle', { name: task.name })
      }
      width={560}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onClose}>
            {t('schedules.editor.cancel')}
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>
            {isNew ? t('schedules.editor.create') : t('schedules.editor.save')}
          </button>
        </>
      }
    >
      <div className="sc-form">
        <div className="sc-grid2">
          <div>
            <label className="sc-label" htmlFor="sc-n">
              {t('schedules.editor.name')}
            </label>
            <input
              id="sc-n"
              className="input"
              // Design: the name has the focus when the editor opens.
              autoFocus
              value={draft.name}
              maxLength={48}
              onChange={(event) => {
                setDraft({ ...draft, name: event.target.value });
              }}
            />
          </div>
          <div>
            <label className="sc-label" htmlFor="sc-a">
              {t('schedules.editor.agent')}
            </label>
            <select
              id="sc-a"
              className="input"
              value={draft.agent}
              disabled={options.length === 0}
              aria-describedby="sc-a-h"
              onChange={(event) => {
                setDraft({ ...draft, agent: event.target.value });
              }}
            >
              {options.length > 0 ? (
                options.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))
              ) : (
                <option value="">{t('schedules.editor.agentNoneOption')}</option>
              )}
            </select>
            <div id="sc-a-h" className="mk-meta" style={{ marginTop: 5, fontSize: 12 }}>
              {options.length > 0
                ? t('schedules.editor.agentHelp')
                : t('schedules.editor.agentNone')}
            </div>
          </div>
        </div>
        <div>
          <label className="sc-label" htmlFor="sc-t">
            {t('schedules.editor.task')}
          </label>
          <textarea
            id="sc-t"
            className="input"
            rows={3}
            maxLength={2000}
            value={draft.task}
            placeholder={
              anomaly
                ? t('schedules.editor.taskPlaceholderAnomaly')
                : t('schedules.editor.taskPlaceholder')
            }
            onChange={(event) => {
              setDraft({ ...draft, task: event.target.value });
            }}
          />
        </div>
        <div>
          <span className="sc-label">{t('schedules.editor.trigger')}</span>
          {isNew ? (
            <>
              <div className="ab-seg" role="group" aria-label={t('schedules.editor.trigger')}>
                <button
                  type="button"
                  className={!anomaly ? 'is-on' : ''}
                  onClick={() => {
                    setDraft({ ...draft, kind: 'schedule' });
                  }}
                >
                  {t('schedules.editor.bySchedule')}
                </button>
                <button
                  type="button"
                  className={anomaly ? 'is-on' : ''}
                  disabled={!canSubscribeEvents}
                  aria-describedby={canSubscribeEvents ? undefined : 'sc-trg-why'}
                  onClick={() => {
                    setDraft({ ...draft, kind: 'event' });
                  }}
                >
                  {t('schedules.editor.byAnomaly')}
                </button>
              </div>
              {!canSubscribeEvents ? (
                <div id="sc-trg-why" className="mk-meta" style={{ marginTop: 6, fontSize: 12 }}>
                  {t('schedules.editor.centralOnly')}
                </div>
              ) : null}
            </>
          ) : (
            <div className="sc-ro">
              {anomaly ? t('schedules.editor.byAnomaly') : t('schedules.editor.bySchedule')}
              <span className="mk-meta">{t('schedules.editor.triggerFixed')}</span>
            </div>
          )}
          {anomaly ? (
            <div className="mc-alert" style={{ marginTop: 10, fontSize: 12.5 }}>
              <ZapIcon size={13} />
              <div>
                <b>{t('schedules.editor.anomalyCap', { count: task?.trigger.daily_cap ?? 5 })}</b>{' '}
                {t('schedules.editor.anomalyNote')}
              </div>
            </div>
          ) : null}
        </div>
        {!anomaly ? (
          <div>
            <span className="sc-label">{t('schedules.editor.frequency')}</span>
            <div
              className="ab-seg sc-wrap"
              role="group"
              aria-label={t('schedules.editor.frequency')}
            >
              {FREQUENCIES.map((freq: Frequency) => (
                <button
                  key={freq}
                  type="button"
                  className={draft.spec.freq === freq ? 'is-on' : ''}
                  onClick={() => {
                    setSpec({ freq });
                  }}
                >
                  {t(`schedules.freq.${freq}`)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 sc-when">
              {draft.spec.freq === 'days' ? (
                <div className="flex items-center gap-1" style={{ flexWrap: 'wrap' }}>
                  {DAYS.map((day) => {
                    const on = draft.spec.days.includes(day);
                    const name = dayName(t, day);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={on}
                        className={`ab-chip${on ? ' is-on' : ''}`}
                        onClick={() => {
                          setSpec({
                            days: on
                              ? draft.spec.days.filter((d) => d !== day)
                              : [...draft.spec.days, day].toSorted((a, b) => a - b),
                          });
                        }}
                      >
                        {name.slice(0, 3)}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {draft.spec.freq === 'weekly' ? (
                <select
                  className="input"
                  style={{ width: 'auto' }}
                  aria-label={t('schedules.editor.day')}
                  value={draft.spec.dow}
                  onChange={(event) => {
                    setSpec({ dow: Number(event.target.value) });
                  }}
                >
                  {DAYS.map((day) => (
                    <option key={day} value={day}>
                      {dayName(t, day)}
                    </option>
                  ))}
                </select>
              ) : null}
              {draft.spec.freq === 'monthly' ? (
                <select
                  className="input"
                  style={{ width: 'auto' }}
                  aria-label={t('schedules.editor.dayOfMonth')}
                  value={draft.spec.dom}
                  onChange={(event) => {
                    setSpec({ dom: Number(event.target.value) });
                  }}
                >
                  {Array.from({ length: 28 }, (_, index) => (
                    <option key={index} value={index + 1}>
                      {t('schedules.editor.dayN', { n: index + 1 })}
                    </option>
                  ))}
                </select>
              ) : null}
              {!['15m', 'hourly', '6h'].includes(draft.spec.freq) ? (
                <input
                  type="time"
                  className="input"
                  style={{ width: 'auto' }}
                  aria-label={t('schedules.editor.time')}
                  value={`${pad2(draft.spec.hour)}:${pad2(draft.spec.minute)}`}
                  onChange={(event) => {
                    const [hour = '0', minute = '0'] = event.target.value.split(':');
                    setSpec({ hour: Number(hour), minute: Number(minute) });
                  }}
                />
              ) : null}
              <select
                className="input"
                style={{ width: 'auto' }}
                aria-label={t('schedules.editor.timezone')}
                value={draft.tz}
                onChange={(event) => {
                  const zone = TIMEZONES.find((value) => value === event.target.value);
                  if (zone) setDraft({ ...draft, tz: zone });
                }}
              >
                {TIMEZONES.map((zone) => (
                  <option key={zone}>{zone}</option>
                ))}
              </select>
            </div>
            <div className="mk-meta" style={{ marginTop: 8 }}>
              {specLabel(t, draft.spec)} · <span className="mono">{cronOf(draft.spec)}</span>
            </div>
            {next === 'computing' ? (
              <div className="mk-meta" style={{ marginTop: 2 }} role="status">
                {t('schedules.editor.computing')}
              </div>
            ) : next && next.length > 0 ? (
              <div className="mk-meta" style={{ marginTop: 2 }}>
                {t('schedules.editor.upcoming', {
                  zone: zoneLabel(t, draft.tz),
                  list: next
                    .map((at) =>
                      new Intl.DateTimeFormat('es-MX', {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                        timeZone: draft.tz,
                      }).format(new Date(at)),
                    )
                    .join(' · '),
                })}
                {otherZone && next[0]
                  ? t('schedules.editor.upcomingYours', { first: FMT.format(new Date(next[0])) })
                  : ''}
              </div>
            ) : null}
            {heavy ? (
              <div className="mc-alert amber" style={{ marginTop: 8, fontSize: 12.5 }}>
                <WarnIcon size={13} />
                <div>
                  {draft.spec.freq === '15m'
                    ? t('schedules.editor.heavy15m', { agent: agentName ?? '' })
                    : t('schedules.editor.heavyHourly', { agent: agentName ?? '' })}
                </div>
              </div>
            ) : null}
            {noDays ? (
              <div className="sc-err" style={{ marginTop: 6, fontSize: 12 }}>
                {t('schedules.editor.errDays')}
              </div>
            ) : null}
          </div>
        ) : null}
        <div>
          <span className="sc-label">{t('schedules.editor.result')}</span>
          <div className="sc-ro">{t('schedules.editor.resultValue')}</div>
          <div className="flex items-center gap-2" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            <span className="mk-meta">{t('schedules.editor.alsoSend')}</span>
            {/* The results stay inside Mango in this wave (A4): Slack and tickets are «Próximamente». */}
            <Soon name={t('schedules.deliver.slack')}>
              <span className="ab-seg">
                <button type="button">{t('schedules.deliver.slack')}</button>
              </span>
            </Soon>
            <Soon name={t('schedules.deliver.ticket')}>
              <span className="ab-seg">
                <button type="button">{t('schedules.deliver.ticket')}</button>
              </span>
            </Soon>
          </div>
        </div>
        <div className="mc-alert" style={{ fontSize: 12.5 }}>
          <UserIcon size={13} />
          <div>
            {t('schedules.editor.note', {
              budget: agentName
                ? t('schedules.editor.noteBudget', { agent: agentName })
                : t('schedules.editor.noteBudgetNone'),
              central: anomaly ? t('schedules.editor.noteCentral') : '',
            })}
          </div>
        </div>
        {tried && errors.length > 0 ? <div className="sc-err">{errors.join(' · ')}</div> : null}
        {failure ? (
          <div className="sc-err" role="alert">
            {failure}
          </div>
        ) : null}
      </div>
    </GovModal>
  );
}

/**
 * Schedules (design schedules.jsx): tasks a published agent runs without chat, as the person who
 * created them (D78), by schedule or on a cost anomaly (D79). Anyone with a usable agent creates
 * them (D82 (1)). Each person sees theirs and administrators see all of them, without their
 * instruction or results (D78 (18), D82 (3)). Every action is authorized by the API; what is
 * hidden here is only what the design hides.
 */
const LINK_ID = /^[0-9a-f]{32}$/;

export function SchedulesPage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const call = api.call;
  const { notify, stack } = useToasts();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState('');
  const [quick, setQuick] = useState<QuickFilter>('all');
  const [agentFilter, setAgentFilter] = useState('all');
  // Deep link `/schedules/<task>[/run/<run>]` (from the Bandeja, D83): untrusted input, only
  // well-formed ids are used, and the task opens only if the list has it for this account.
  const [routeTask = '', routeKind = '', routeRun = ''] = (useParams()['*'] ?? '').split('/');
  const [selected, setSelected] = useState<{
    id: string;
    ask: 'pause' | null;
    run: string | null;
  } | null>(() =>
    LINK_ID.test(routeTask)
      ? {
          id: routeTask,
          ask: null,
          run: routeKind === 'run' && LINK_ID.test(routeRun) ? routeRun : null,
        }
      : null,
  );
  const [editing, setEditing] = useState<{ task: Task | null } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Runs seen queued or running, by id: their end is told once (design toast). */
  const openRuns = useRef(new Map<string, Task>());
  const isAdmin = me.is_admin;

  const ready = state.kind === 'ready' ? state : null;
  const anyOpen = ready?.list.items.some((task) => task.runs.some(isOpen)) ?? false;

  useEffect(() => {
    const controller = new AbortController();
    const load = (first: boolean) => {
      Promise.all([
        call('listTasksOfCaller', {}, { signal: controller.signal }),
        call('getAgents', {}, { signal: controller.signal }),
      ]).then(
        ([list, agents]) => {
          if (controller.signal.aborted) return;
          const seen = openRuns.current;
          for (const item of list.items) {
            for (const run of item.runs) {
              if (isOpen(run)) {
                seen.set(run.run_id, item);
              } else if (seen.delete(run.run_id)) {
                const done = run.status === 'ok';
                const open = { id: item.task_id, ask: null, run: done ? run.run_id : null };
                notify(
                  done
                    ? t('schedules.toast.doneBody')
                    : (runReason(t, run.reason) ?? t('schedules.run.unknownReason')),
                  done ? 'success' : 'info',
                  done
                    ? t('schedules.toast.doneTitle', { name: item.name })
                    : t('schedules.toast.failedTitle', { name: item.name }),
                  {
                    duration: DONE_TOAST_MS,
                    action: {
                      label:
                        done && item.is_owner
                          ? t('schedules.run.seeResult')
                          : t('schedules.toast.seeRun'),
                      onClick: () => {
                        setSelected(item.is_owner ? open : { ...open, run: null });
                      },
                    },
                  },
                );
              }
            }
          }
          setState({ kind: 'ready', list, agents: agents.items });
        },
        () => {
          if (!controller.signal.aborted && first) setState({ kind: 'error' });
        },
      );
    };
    load(true);
    const timer = window.setInterval(
      () => {
        if (document.visibilityState !== 'hidden') load(false);
      },
      anyOpen ? RUN_POLL_MS : POLL_MS,
    );
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [call, reloadToken, anyOpen, notify, t]);

  const agentsById = useMemo(
    () => new Map((ready?.agents ?? []).map((agent) => [agent.id, agent])),
    [ready],
  );
  const usable = useMemo(
    () => (ready?.agents ?? []).filter((agent) => agent.status === 'published'),
    [ready],
  );
  const tasks = useMemo(() => ready?.list.items ?? [], [ready]);
  const healths = useMemo(
    () =>
      new Map(
        tasks.map((task) => [
          task.task_id,
          healthOf(task, agentsById.get(task.agent_id)?.unavailable_tools),
        ]),
      ),
    [tasks, agentsById],
  );
  const agentName = useCallback(
    (task: Task) => task.agent_name ?? agentsById.get(task.agent_id)?.name ?? task.agent_id,
    [agentsById],
  );

  const replace = useCallback((task: Task) => {
    setState((current) =>
      current.kind === 'ready'
        ? {
            ...current,
            list: {
              ...current.list,
              items: current.list.items.some((item) => item.task_id === task.task_id)
                ? current.list.items.map((item) => (item.task_id === task.task_id ? task : item))
                : [task, ...current.list.items],
            },
          }
        : current,
    );
  }, []);

  const act = useCallback(
    (work: () => Promise<Task | null>, message: string) => {
      setBusy(true);
      work().then(
        (task) => {
          setBusy(false);
          if (task) replace(task);
          notify(message, 'info');
        },
        (error: unknown) => {
          setBusy(false);
          notify(errorToast(t, error), 'error');
        },
      );
    },
    [notify, replace, t],
  );

  const runNow = useCallback(
    (task: Task) => {
      act(
        async () => {
          await call('runTaskNow', { path: { task_id: task.task_id }, body: {} });
          return call('getTask', { path: { task_id: task.task_id } });
        },
        t('schedules.toast.queued', { name: task.name }),
      );
    },
    [act, call, t],
  );
  const pause = useCallback(
    (task: Task, reason: string | null) => {
      act(
        () =>
          call('pauseExistingTask', {
            path: { task_id: task.task_id },
            body: reason ? { reason } : {},
          }),
        task.is_owner
          ? t('schedules.toast.paused', { name: task.name })
          : t('schedules.toast.pausedAdmin', { name: task.name }),
      );
    },
    [act, call, t],
  );
  const resume = useCallback(
    (task: Task) => {
      act(
        () => call('resumePausedTask', { path: { task_id: task.task_id }, body: {} }),
        t('schedules.toast.resumed', { name: task.name }),
      );
    },
    [act, call, t],
  );
  const openTask = useCallback((task: Task, ask?: 'pause') => {
    setSelected({ id: task.task_id, ask: ask ?? null, run: null });
  }, []);

  const q = query.trim().toLowerCase();
  // Design: the search only looks at the instruction of one's own tasks.
  const base = tasks.filter(
    (task) =>
      (agentFilter === 'all' || task.agent_id === agentFilter) &&
      (!q || `${task.name} ${task.is_owner ? (task.task ?? '') : ''}`.toLowerCase().includes(q)),
  );
  const visible = base.filter((task) =>
    matchesQuick(task, quick, healths.get(task.task_id) ?? null),
  );
  const active = tasks.filter((task) => task.status === 'active');
  const paused = tasks.filter((task) => task.status === 'paused').length;
  const attention = tasks.filter((task) =>
    needsAttention(task, healths.get(task.task_id) ?? null),
  ).length;
  const anomalyTasks = active.some(isEvent);
  const next = active
    .flatMap((task) =>
      !isEvent(task) && task.next_runs[0] ? [{ task, at: task.next_runs[0] }] : [],
    )
    .toSorted((a, b) => a.at.localeCompare(b.at))[0];
  const selectedTask = selected
    ? (tasks.find((task) => task.task_id === selected.id) ?? null)
    : null;
  const canCreate = ready?.list.can_create ?? false;

  return (
    <>
      <Topbar
        crumbs={[t('schedules.crumbBuild'), t('schedules.title')]}
        actions={
          canCreate ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!ready || usable.length === 0}
              title={ready && usable.length === 0 ? t('schedules.createNoAgents') : undefined}
              onClick={() => {
                setEditing({ task: null });
              }}
            >
              <PlusIcon size={12} /> {t('schedules.create')}
            </button>
          ) : null
        }
      />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('schedules.title')}</h1>
          <p className="page-subtitle">
            {t('schedules.subtitle')}
            {isAdmin ? t('schedules.subtitleAdmin') : ''}
          </p>
        </div>
        {state.kind === 'error' ? (
          <div role="alert">
            <GovErrorState
              title={t('schedules.loadErrorTitle')}
              body={t('schedules.loadErrorBody')}
              onRetry={() => {
                setState({ kind: 'loading' });
                setReloadToken((value) => value + 1);
              }}
            />
          </div>
        ) : !ready ? (
          <div role="status" aria-label={t('schedules.loading')}>
            <Skel w="40%" h={13} />
            <Skel w="80%" h={11} />
          </div>
        ) : (
          <>
            <div className="bg-kpis">
              <div className="card bg-kpi">
                <span className="bg-kpi-l">{t('schedules.kpi.active')}</span>
                <span className="bg-kpi-v">{active.length}</span>
                <span className="bg-kpi-s">{t('schedules.kpi.paused', { count: paused })}</span>
              </div>
              <div className="card bg-kpi">
                <span className="bg-kpi-l">{t('schedules.kpi.next')}</span>
                <span className="bg-kpi-v" style={{ fontSize: 17 }}>
                  {next ? TIME.format(new Date(next.at)) : '—'}
                </span>
                <span className="bg-kpi-s">
                  {next ? next.task.name : t('schedules.kpi.noneNext')}
                </span>
              </div>
              <div className="card bg-kpi">
                <span className="bg-kpi-l">{t('schedules.kpi.attention')}</span>
                <span
                  className="bg-kpi-v"
                  style={attention ? { color: 'var(--amber)' } : undefined}
                >
                  {attention}
                </span>
                <span className="bg-kpi-s">{t('schedules.kpi.attentionSub')}</span>
              </div>
              <div className="card bg-kpi">
                <span className="bg-kpi-l">{t('schedules.kpi.cost')}</span>
                <span className="bg-kpi-v">{formatUsd(monthlyEstimate(tasks).toFixed(2))}</span>
                <span className="bg-kpi-s">
                  {anomalyTasks ? t('schedules.kpi.costSubAnomaly') : t('schedules.kpi.costSub')}
                </span>
              </div>
            </div>
            <div className="bg-toolbar">
              <div className="search-wrap" style={{ flex: '1 1 220px', maxWidth: 300 }}>
                <SearchIcon size={13} />
                <input
                  className="input"
                  placeholder={t('schedules.search')}
                  aria-label={t('schedules.searchLabel')}
                  value={query}
                  maxLength={100}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                />
              </div>
              <div className="tk-quick" role="group" aria-label={t('schedules.quickLabel')}>
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
                    {t(`schedules.quick.${key}`)}
                    <span className="mk-count">
                      {
                        base.filter((task) =>
                          matchesQuick(task, key, healths.get(task.task_id) ?? null),
                        ).length
                      }
                    </span>
                  </button>
                ))}
              </div>
              <select
                className="input mk-sel"
                aria-label={t('schedules.agentLabel')}
                value={agentFilter}
                onChange={(event) => {
                  setAgentFilter(event.target.value);
                }}
              >
                <option value="all">{t('schedules.anyAgent')}</option>
                {[...new Map(tasks.map((task) => [task.agent_id, agentName(task)]))].map(
                  ([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ),
                )}
              </select>
            </div>
            <div className="mc-body" style={{ paddingTop: 0 }}>
              <div className="card mc-table">
                <div className="sc-tr mc-th">
                  <span>{t('schedules.columns.schedule')}</span>
                  <span>{t('schedules.columns.when')}</span>
                  <span>{t('schedules.columns.next')}</span>
                  <span>{t('schedules.columns.runs')}</span>
                  <span>{t('schedules.columns.status')}</span>
                  <span />
                </div>
                {visible.map((task) => (
                  <TaskRow
                    key={task.task_id}
                    task={task}
                    perms={permsOf(task, isAdmin)}
                    agentName={agentName(task)}
                    health={healths.get(task.task_id) ?? null}
                    busy={busy}
                    onOpen={openTask}
                    onRun={runNow}
                    onPause={(item) => {
                      pause(item, null);
                    }}
                    onResume={resume}
                  />
                ))}
                {visible.length === 0 ? (
                  <div className="mk-meta" style={{ padding: 16 }}>
                    {tasks.length > 0
                      ? t('schedules.noneMatch')
                      : usable.length > 0 && canCreate
                        ? t('schedules.emptyMine')
                        : t('schedules.emptyNoAgents')}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
      {selected && selectedTask && ready ? (
        <TaskDetail
          key={`${selectedTask.task_id}:${selected.ask ?? ''}:${selected.run ?? ''}`}
          api={call}
          task={selectedTask}
          isAdmin={isAdmin}
          agentName={agentName(selectedTask)}
          health={healths.get(selectedTask.task_id) ?? null}
          busy={busy}
          ask0={selected.ask}
          run0={selected.run}
          onClose={() => {
            setSelected(null);
          }}
          onEdit={() => {
            setEditing({ task: selectedTask });
          }}
          onRun={() => {
            runNow(selectedTask);
          }}
          onPause={(reason) => {
            pause(selectedTask, reason);
          }}
          onResume={() => {
            resume(selectedTask);
          }}
          onRetire={(reason) => {
            act(
              () =>
                call('retireExistingTask', {
                  path: { task_id: selectedTask.task_id },
                  body: { reason },
                }),
              t('schedules.toast.retired', { name: selectedTask.name }),
            );
          }}
        />
      ) : null}
      {editing && ready ? (
        <TaskEditor
          api={call}
          task={editing.task}
          agents={usable}
          allAgents={agentsById}
          canSubscribeEvents={ready.list.can_subscribe_events}
          onClose={() => {
            setEditing(null);
          }}
          onSaved={(saved, created) => {
            setEditing(null);
            replace(saved);
            setSelected({ id: saved.task_id, ask: null, run: null });
            notify(created ? t('schedules.toast.created') : t('schedules.toast.saved'));
          }}
        />
      ) : null}
      {stack}
    </>
  );
}
