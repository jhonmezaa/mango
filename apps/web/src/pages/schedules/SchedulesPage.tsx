import type { TFunction } from 'i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { ApiError } from '../../api/errors';
import type { OperationCaller } from '../../api/operations';
import { useSession } from '../../auth/useSession';
import { ChatMarkdown } from '../../components/ChatMarkdown';
import { GovErrorState, GovModal, Skel } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import {
  ArchiveIcon,
  ClockIcon,
  EditIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  UserIcon,
  WarnIcon,
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
  canHold,
  canRunNow,
  canToggle,
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
  type Frequency,
  type Health,
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
const TONE_COLOR = {
  green: 'var(--green)',
  red: 'var(--red)',
  dim: 'var(--text-dim)',
  amber: 'var(--amber)',
  accent: 'var(--accent)',
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

function runReason(t: Translate, reason: string | null): string | null {
  if (!reason) return null;
  return isRunReason(reason) ? t(`schedules.run.reason.${reason}`) : reason;
}

function triggerLabel(t: Translate, task: Task): string {
  if (isEvent(task)) return t('schedules.event.label');
  return task.trigger.schedule ? specLabel(t, task.trigger.schedule) : '—';
}

/** Design: «como {owner}», the person the task runs as, for the owner too. */
function ownerName(_t: Translate, task: Task): string {
  return task.owner.name ?? task.owner.email ?? task.owner.user_id;
}

function healthText(t: Translate, task: Task, health: Health): string {
  const owner = ownerName(t, task);
  switch (health.key) {
    case 'agent_unavailable':
      return t('schedules.health.agent_unavailable');
    case 'access_lost':
      return t('schedules.health.access_lost', { owner });
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

function RunDots({ task }: { task: Task }) {
  const { t } = useTranslation();
  if (task.runs.length === 0) return <span className="mk-meta">{t('schedules.noRuns')}</span>;
  return (
    <span className="sc-dots" aria-label={t('schedules.runsLabel')}>
      {task.runs
        .slice(0, 10)
        .toReversed()
        .map((run) => (
          <i
            key={run.run_id}
            title={`${t(`schedules.run.${run.status}`)} · ${FMT.format(new Date(run.queued_at))}`}
            style={{ background: TONE_COLOR[RUN_TONE[run.status] ?? 'dim'] }}
          />
        ))}
    </span>
  );
}

interface RowProps {
  task: Task;
  isAdmin: boolean;
  agentName: string;
  health: Health | null;
  busy: boolean;
  onOpen: (task: Task) => void;
  onRun: (task: Task) => void;
  onToggle: (task: Task) => void;
}

function TaskRow({ task, isAdmin, agentName, health, busy, onOpen, onRun, onToggle }: RowProps) {
  const { t } = useTranslation();
  const next = task.status === 'active' ? task.next_runs[0] : undefined;
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
            owner: ownerName(t, task),
            deliver: t(`schedules.deliver.${task.deliver}`),
          })}
        </span>
      </span>
      <span style={{ fontSize: 13 }}>
        {triggerLabel(t, task)}
        <span className="mk-meta" style={{ display: 'block' }}>
          {isEvent(task)
            ? t('schedules.event.cap', { count: task.trigger.daily_cap ?? 0 })
            : task.trigger.timezone}
        </span>
      </span>
      <span className="mk-meta">
        {task.running ? (
          <span className="flex items-center gap-2">
            <span className="g-spin" /> {t('schedules.running')}
          </span>
        ) : next ? (
          FMT.format(new Date(next))
        ) : (
          '—'
        )}
      </span>
      <RunDots task={task} />
      <span className="flex items-center gap-1" style={{ flexWrap: 'wrap' }}>
        <span className={`badge ${STATUS_BADGE[task.status]}`}>
          {t(`schedules.status.${task.status}`)}
        </span>
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
        {canRunNow(task) ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon"
            title={t('schedules.runNow')}
            aria-label={t('schedules.runNowOf', { name: task.name })}
            disabled={task.running || busy}
            onClick={() => {
              onRun(task);
            }}
          >
            <PlayIcon size={12} />
          </button>
        ) : null}
        {canToggle(task, isAdmin) ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon"
            title={task.status === 'paused' ? t('schedules.resume') : t('schedules.pause')}
            aria-label={
              task.status === 'paused'
                ? t('schedules.resumeOf', { name: task.name })
                : t('schedules.pauseOf', { name: task.name })
            }
            disabled={busy}
            onClick={() => {
              onToggle(task);
            }}
          >
            {task.status === 'paused' ? <PlayIcon size={12} /> : <PauseIcon size={12} />}
          </button>
        ) : null}
      </span>
    </div>
  );
}

function RunLine({
  run,
  onResult,
  onApproval,
}: {
  run: TaskRun;
  onResult: (run: TaskRun) => void;
  onApproval: (id: string) => void;
}) {
  const { t } = useTranslation();
  const ms = durationMs(run);
  const reason = runReason(t, run.reason);
  const approval = run.approvals[0];
  return (
    <div className="mk-line flex justify-between gap-3" style={{ alignItems: 'flex-start' }}>
      <span className="flex items-center gap-2" style={{ minWidth: 0 }}>
        <span
          className="tk-dot"
          style={{ background: TONE_COLOR[RUN_TONE[run.status] ?? 'dim'], marginTop: 6 }}
        />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block' }}>
            {t(`schedules.run.${run.status}`)}
            {run.trigger === 'manual' ? t('schedules.run.manual') : ''}
          </span>
          {reason ? (
            <span
              className="mk-meta"
              style={{
                display: 'block',
                color: run.status === 'failed' ? 'var(--red)' : undefined,
              }}
            >
              {reason}
            </span>
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
          {run.has_result ? (
            <button
              type="button"
              className="sr-link block"
              onClick={() => {
                onResult(run);
              }}
            >
              {t('schedules.run.seeResult')}
            </button>
          ) : null}
        </span>
      </span>
      <span className="mk-meta mono" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {formatRelative(run.queued_at)}
        {ms !== null ? (
          <>
            <br />
            {t('schedules.run.meta', {
              seconds: (ms / 1000).toFixed(1).replace('.', ','),
              cost: run.cost_usd ? formatUsd(run.cost_usd) : '—',
            })}
          </>
        ) : null}
      </span>
    </div>
  );
}

interface DetailProps {
  task: Task;
  isAdmin: boolean;
  agentName: string;
  health: Health | null;
  canControl: boolean;
  busy: boolean;
  onClose: () => void;
  onEdit: () => void;
  onRun: () => void;
  onToggle: () => void;
  onHold: () => void;
  onRetire: (reason: string) => void;
  onResult: (run: TaskRun) => void;
}

function TaskDetail({
  task,
  isAdmin,
  agentName,
  health,
  canControl,
  busy,
  onClose,
  onEdit,
  onRun,
  onToggle,
  onHold,
  onRetire,
  onResult,
}: DetailProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [retiring, setRetiring] = useState(false);
  const [why, setWhy] = useState('');
  const owner = ownerName(t, task);
  const lost = task.paused_reason === 'access_lost';
  const byAdmin = task.status === 'paused' && task.paused_reason === 'admin';
  const ok = task.runs.filter((run) => run.status === 'ok').length;
  const spec = task.trigger.schedule;
  const footer =
    canControl && task.status !== 'retired' ? (
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
        {retiring ? (
          <>
            <input
              className="input"
              style={{ flex: '1 1 200px' }}
              value={why}
              maxLength={200}
              onChange={(event) => {
                setWhy(event.target.value);
              }}
              placeholder={t('schedules.detail.retireReason')}
              aria-label={t('schedules.detail.retireReason')}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setRetiring(false);
              }}
            >
              {t('schedules.detail.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!why.trim() || busy}
              onClick={() => {
                onRetire(why.trim());
                setRetiring(false);
              }}
            >
              <ArchiveIcon size={12} /> {t('schedules.detail.retire')}
            </button>
          </>
        ) : (
          <>
            {task.is_owner ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={task.running || !canRunNow(task) || busy}
                title={byAdmin ? t('schedules.detail.adminPausedTitle') : undefined}
                onClick={onRun}
              >
                <PlayIcon size={12} />{' '}
                {task.running ? t('schedules.running') : t('schedules.runNow')}
              </button>
            ) : null}
            {task.status !== 'paused' || task.is_owner || isAdmin ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={(task.status === 'paused' && !canToggle(task, isAdmin)) || busy}
                title={
                  lost
                    ? t('schedules.detail.lostTitle')
                    : byAdmin && !isAdmin
                      ? t('schedules.detail.adminPausedTitle')
                      : undefined
                }
                onClick={onToggle}
              >
                {task.status === 'paused' ? t('schedules.resume') : t('schedules.pause')}
              </button>
            ) : null}
            {canHold(task, isAdmin) ? (
              // Not in the design yet (A1 of the second review, D78 (19)): an administrator
              // also holds a task its owner paused, and the brake of D2 applies.
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                title={t('schedules.detail.holdTitle')}
                onClick={onHold}
              >
                {t('schedules.pause')}
              </button>
            ) : null}
            {task.is_owner ? (
              <button type="button" className="btn btn-sm" disabled={lost || busy} onClick={onEdit}>
                <EditIcon size={12} /> {t('schedules.detail.edit')}
              </button>
            ) : null}
            {!task.is_owner ? (
              <span className="ap-reason" style={{ flexBasis: '100%', order: 9 }}>
                <LockIcon size={12} /> {t('schedules.detail.ownerOnly', { owner })}
              </span>
            ) : null}
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setRetiring(true);
              }}
            >
              <ArchiveIcon size={12} /> {t('schedules.detail.retire')}
            </button>
          </>
        )}
      </div>
    ) : undefined;

  return (
    <SidePanel
      title={task.name}
      width={520}
      lead={
        <span className="mc-ic lg">
          <ClockIcon size={20} />
        </span>
      }
      meta={`${agentName} · ${triggerLabel(t, task)}`}
      onClose={onClose}
      footer={footer}
    >
      {health ? (
        <div className={`mc-alert ${health.tone}`}>
          <WarnIcon size={14} />
          <div>{healthText(t, task, health)}.</div>
        </div>
      ) : null}
      {task.status === 'paused' && !lost ? (
        <div className="mc-alert">
          <PauseIcon size={14} />
          {/* Not in the design yet (D2 after the review, reported): an administrator's pause. */}
          <div>{byAdmin ? t('schedules.detail.adminPaused') : t('schedules.detail.paused')}</div>
        </div>
      ) : null}
      {task.status === 'paused' && lost && task.paused_at ? (
        <div className="mc-alert red">
          <LockIcon size={14} />
          <div>
            <b>{t('schedules.detail.autoPausedTitle', { ago: formatRelative(task.paused_at) })}</b>{' '}
            {t('schedules.detail.lostReason', { owner })}. {t('schedules.detail.autoPausedBody')}
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
        <div className="sc-task">{task.task}</div>
      </section>
      <section className="mk-sec">
        <h3 className="mk-sec-t">
          {(spec ? t('schedules.detail.schedule') : t('schedules.detail.trigger')).toLowerCase()}
        </h3>
        {spec ? (
          <>
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
            {task.next_runs.length > 0 ? (
              <div className="mk-kv">
                <span>{t('schedules.detail.upcoming')}</span>
                <span style={{ textAlign: 'right' }}>
                  {task.next_runs.map((at) => (
                    <div key={at}>{FMT.format(new Date(at))}</div>
                  ))}
                </span>
              </div>
            ) : null}
          </>
        ) : (
          <div className="mk-kv">
            <span>{t('schedules.detail.trigger')}</span>
            <span>
              {triggerLabel(t, task)}
              {isEvent(task)
                ? ` · ${t('schedules.event.cap', { count: task.trigger.daily_cap ?? 0 })}`
                : ''}
            </span>
          </div>
        )}
      </section>
      <section className="mk-sec">
        <h3 className="mk-sec-t">{t('schedules.detail.control').toLowerCase()}</h3>
        <div className="mk-kv">
          <span>{t('schedules.detail.result')}</span>
          <span>{t(`schedules.deliver.${task.deliver}`)}</span>
        </div>
        <div className="mk-kv">
          <span>{t('schedules.detail.runsAs')}</span>
          <span>{t('schedules.detail.runsAsValue', { owner })}</span>
        </div>
        <div className="mk-kv">
          <span>{t('schedules.detail.agent')}</span>
          <span>{t('schedules.detail.agentValue', { agent: agentName })}</span>
        </div>
        <div className="mk-kv">
          <span>{t('schedules.detail.ifLost', { owner })}</span>
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
        {task.runs.length > 0 ? (
          task.runs.map((run) => (
            <RunLine
              key={run.run_id}
              run={run}
              onResult={onResult}
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
    task: task.task,
    kind: isEvent(task) ? 'event' : 'schedule',
    spec: { ...DEFAULT_SPEC, ...task.trigger.schedule },
    tz,
  };
}

function TaskEditor({
  api,
  task,
  agents,
  canSubscribeEvents,
  onClose,
  onSaved,
}: {
  api: OperationCaller;
  task: Task | null;
  agents: Agent[];
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
  const agentName = agents.find((agent) => agent.id === draft.agent)?.name ?? draft.agent;
  const setSpec = (patch: Partial<Spec>) => {
    setDraft((current) => ({ ...current, spec: { ...current.spec, ...patch } }));
  };
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push(t('schedules.editor.errName'));
  if (!draft.task.trim()) errors.push(t('schedules.editor.errTask'));
  if (draft.kind === 'schedule' && draft.spec.freq === 'days' && draft.spec.days.length === 0) {
    errors.push(t('schedules.editor.errDays'));
  }
  const heavy =
    draft.kind === 'schedule' && (draft.spec.freq === '15m' || draft.spec.freq === 'hourly');
  const owner = task ? ownerName(t, task) : '';

  const save = () => {
    setTried(true);
    if (errors.length > 0 || busy) return;
    setBusy(true);
    setFailure(null);
    const trigger =
      draft.kind === 'event'
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
        {agents.length === 0 ? (
          <div className="mc-alert amber">{t('schedules.editor.noAgents')}</div>
        ) : null}
        <div className="sc-grid2">
          <div>
            <label className="sc-label" htmlFor="sc-n">
              {t('schedules.editor.name')}
            </label>
            <input
              id="sc-n"
              className="input"
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
              onChange={(event) => {
                setDraft({ ...draft, agent: event.target.value });
              }}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
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
            placeholder={t('schedules.editor.taskPlaceholder')}
            onChange={(event) => {
              setDraft({ ...draft, task: event.target.value });
            }}
          />
        </div>
        {isNew ? (
          // Not in the design yet (D24, reported): the trigger of cost anomalies (D79).
          <div>
            <span className="sc-label">{t('schedules.editor.trigger')}</span>
            <div className="ab-seg" role="group" aria-label={t('schedules.editor.trigger')}>
              <button
                type="button"
                className={draft.kind === 'schedule' ? 'is-on' : ''}
                onClick={() => {
                  setDraft({ ...draft, kind: 'schedule' });
                }}
              >
                {t('schedules.editor.bySchedule')}
              </button>
              <button
                type="button"
                className={draft.kind === 'event' ? 'is-on' : ''}
                disabled={!canSubscribeEvents}
                title={canSubscribeEvents ? undefined : t('schedules.editor.centralOnly')}
                onClick={() => {
                  setDraft({ ...draft, kind: 'event' });
                }}
              >
                {t('schedules.editor.byAnomaly')}
              </button>
            </div>
            {!canSubscribeEvents ? (
              <div className="mk-meta sc-note">{t('schedules.editor.centralOnly')}</div>
            ) : null}
          </div>
        ) : null}
        {draft.kind === 'schedule' ? (
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
                  className="input sc-auto"
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
                  className="input sc-auto"
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
                  className="input sc-auto"
                  aria-label={t('schedules.editor.time')}
                  value={`${pad2(draft.spec.hour)}:${pad2(draft.spec.minute)}`}
                  onChange={(event) => {
                    const [hour = '0', minute = '0'] = event.target.value.split(':');
                    setSpec({ hour: Number(hour), minute: Number(minute) });
                  }}
                />
              ) : null}
              <select
                className="input sc-auto"
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
            <div className="mk-meta sc-note">
              {specLabel(t, draft.spec)} · <span className="mono">{cronOf(draft.spec)}</span>
            </div>
            {heavy ? (
              <div className="mc-alert amber sc-note">
                <WarnIcon size={13} />
                <div>
                  {draft.spec.freq === '15m'
                    ? t('schedules.editor.heavy15m', { agent: agentName })
                    : t('schedules.editor.heavyHourly', { agent: agentName })}
                </div>
              </div>
            ) : null}
            {tried && draft.spec.freq === 'days' && draft.spec.days.length === 0 ? (
              <div className="sc-err">{t('schedules.editor.errDays')}</div>
            ) : null}
          </div>
        ) : null}
        <div>
          <span className="sc-label">{t('schedules.editor.deliverTo')}</span>
          <div
            className="flex items-center gap-2"
            style={{ flexWrap: 'wrap', alignItems: 'center' }}
          >
            <div className="ab-seg">
              <button type="button" className="is-on">
                {t('schedules.deliver.inbox')}
              </button>
            </div>
            {/* Delivery stays inside Mango in this wave (A4): tickets and Slack are «Próximamente». */}
            <Soon name={t('schedules.deliver.ticket')}>
              <span className="ab-seg">
                <button type="button">{t('schedules.deliver.ticket')}</button>
              </span>
            </Soon>
            <Soon name={t('schedules.deliver.slack')}>
              <span className="ab-seg">
                <button type="button">{t('schedules.deliver.slack')}</button>
              </span>
            </Soon>
          </div>
        </div>
        <div className="mc-alert sc-note">
          <UserIcon size={13} />
          <div>
            {t('schedules.editor.note', {
              who: isNew
                ? t('schedules.editor.noteNew')
                : t('schedules.editor.noteOwner', { owner }),
              agent: agentName,
              lose: isNew ? t('schedules.editor.loseNew') : t('schedules.editor.loseOwner'),
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

function RunResult({
  api,
  task,
  run,
  onClose,
}: {
  api: OperationCaller;
  task: Task;
  run: TaskRun;
  onClose: () => void;
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
  return (
    <GovModal
      title={t('schedules.detail.resultTitle', { when: FMT.format(new Date(run.queued_at)) })}
      sub={task.name}
      width={640}
      onClose={onClose}
    >
      {detail === null ? (
        <div role="status" aria-label={t('schedules.detail.resultLoading')}>
          <Skel w="70%" h={13} />
          <Skel w="90%" h={11} />
        </div>
      ) : detail === 'error' ? (
        <div className="sc-err" role="alert">
          {t('schedules.detail.resultError')}
        </div>
      ) : detail.result ? (
        // The agent's answer: Markdown without raw HTML (AGENTS.md, REACT-MARKUP-001).
        <div className="sc-result">
          <ChatMarkdown>{detail.result}</ChatMarkdown>
        </div>
      ) : (
        <div className="mk-meta">{t('schedules.detail.noResult')}</div>
      )}
    </GovModal>
  );
}

/**
 * Schedules (design schedules.jsx): tasks a published agent runs without chat, as the person who
 * created them (D78). Each person sees their tasks and administrators see all of them. Every
 * action is authorized by the API; what is hidden here is only what the design hides.
 */
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ task: Task | null } | null>(null);
  const [result, setResult] = useState<{ task: Task; run: TaskRun } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Runs seen queued or running, by id: their end is told once (design toast). */
  const openRuns = useRef(new Map<string, Task>());

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
                notify(
                  run.status === 'ok'
                    ? t('schedules.toast.done', {
                        name: item.name,
                        deliver: t('schedules.deliver.inbox').toLowerCase(),
                      })
                    : t('schedules.toast.failed', { name: item.name }),
                  run.status === 'ok' ? 'success' : 'info',
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
  const toggle = useCallback(
    (task: Task) => {
      if (task.status === 'paused') {
        act(
          () => call('resumePausedTask', { path: { task_id: task.task_id }, body: {} }),
          t('schedules.toast.resumed', { name: task.name }),
        );
      } else {
        act(
          () => call('pauseExistingTask', { path: { task_id: task.task_id }, body: {} }),
          t('schedules.toast.paused', { name: task.name }),
        );
      }
    },
    [act, call, t],
  );

  const q = query.trim().toLowerCase();
  const base = tasks.filter(
    (task) =>
      (agentFilter === 'all' || task.agent_id === agentFilter) &&
      (!q || `${task.name} ${task.task}`.toLowerCase().includes(q)),
  );
  const visible = base.filter((task) =>
    matchesQuick(task, quick, healths.get(task.task_id) ?? null),
  );
  const active = tasks.filter((task) => task.status === 'active');
  const paused = tasks.filter((task) => task.status === 'paused').length;
  const attention = tasks.filter((task) =>
    needsAttention(task, healths.get(task.task_id) ?? null),
  ).length;
  const next = active
    .flatMap((task) => (task.next_runs[0] ? [{ task, at: task.next_runs[0] }] : []))
    .toSorted((a, b) => a.at.localeCompare(b.at))[0];
  const selected = selectedId ? (tasks.find((task) => task.task_id === selectedId) ?? null) : null;
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
              disabled={!ready}
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
          <p className="page-subtitle">{t('schedules.subtitle')}</p>
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
                <span className="bg-kpi-s">{t('schedules.kpi.costSub')}</span>
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
                  <span>{t('schedules.columns.frequency')}</span>
                  <span>{t('schedules.columns.next')}</span>
                  <span>{t('schedules.columns.runs')}</span>
                  <span>{t('schedules.columns.status')}</span>
                  <span />
                </div>
                {visible.map((task) => (
                  <TaskRow
                    key={task.task_id}
                    task={task}
                    isAdmin={me.is_admin}
                    agentName={agentName(task)}
                    health={healths.get(task.task_id) ?? null}
                    busy={busy}
                    onOpen={(item) => {
                      setSelectedId(item.task_id);
                    }}
                    onRun={runNow}
                    onToggle={toggle}
                  />
                ))}
                {visible.length === 0 ? (
                  <div className="mk-meta" style={{ padding: 16 }}>
                    {t('schedules.noneMatch')}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
      {selected && ready ? (
        <TaskDetail
          task={selected}
          isAdmin={me.is_admin}
          agentName={agentName(selected)}
          health={healths.get(selected.task_id) ?? null}
          // The API lists only the tasks the caller may pause and retire (owner or administrator).
          canControl
          busy={busy}
          onClose={() => {
            setSelectedId(null);
          }}
          onEdit={() => {
            setEditing({ task: selected });
          }}
          onRun={() => {
            runNow(selected);
          }}
          onToggle={() => {
            toggle(selected);
          }}
          onHold={() => {
            act(
              () => call('pauseExistingTask', { path: { task_id: selected.task_id }, body: {} }),
              t('schedules.toast.paused', { name: selected.name }),
            );
          }}
          onRetire={(reason) => {
            act(
              () =>
                call('retireExistingTask', {
                  path: { task_id: selected.task_id },
                  body: { reason },
                }),
              t('schedules.toast.retired', { name: selected.name }),
            );
          }}
          onResult={(run) => {
            setResult({ task: selected, run });
          }}
        />
      ) : null}
      {editing && ready ? (
        <TaskEditor
          api={call}
          task={editing.task}
          agents={usable}
          canSubscribeEvents={ready.list.can_subscribe_events}
          onClose={() => {
            setEditing(null);
          }}
          onSaved={(saved, created) => {
            setEditing(null);
            replace(saved);
            setSelectedId(saved.task_id);
            notify(created ? t('schedules.toast.created') : t('schedules.toast.saved'));
          }}
        />
      ) : null}
      {result ? (
        <RunResult
          api={call}
          task={result.task}
          run={result.run}
          onClose={() => {
            setResult(null);
          }}
        />
      ) : null}
      {stack}
    </>
  );
}
