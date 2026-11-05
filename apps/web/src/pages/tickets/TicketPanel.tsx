import { useEffect, useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import type { Agent } from '../../agents/agents';
import type { ApiClient } from '../../api/client';
import type { Me } from '../../api/schemas';
import { ChatMarkdown } from '../../components/ChatMarkdown';
import {
  ArrowRightIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  LockIcon,
  RefreshIcon,
  WarnIcon,
} from '../../components/icons';
import { Soon, SoonTag } from '../../components/Soon';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { formatRelative, initialsFor } from '../../lib/format';
import { TicketAgent } from './TicketBits';
import {
  MAX_COMMENT,
  PRIORITIES,
  STATUSES,
  activity,
  assignable,
  canMoveTo,
  errorKey,
  personLabel,
  shortId,
  type ActivityLine,
  type ChosenStatus,
  type Person,
  type Priority,
  type TicketDetail,
} from './model';

/** The fields a person changes from the panel (PATCH /api/tickets/{id}). */
export interface TicketPatch {
  status?: ChosenStatus;
  priority?: Priority;
  assignee_id?: string | null;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'gone' }
  | { kind: 'ready'; detail: TicketDetail };

interface Props {
  api: ApiClient;
  me: Me;
  /** The ticket of the URL; null when the URL names no valid id (nothing is asked). */
  ticketId: string | null;
  agents: ReadonlyMap<string, Agent>;
  /** Ids of the agents the person may use now; null while they load. */
  usable: ReadonlySet<string> | null;
  onClose: () => void;
  /** Applies a change; resolves with the ticket the API answered, or null when it refused. */
  onChange: (detail: TicketDetail, patch: TicketPatch) => Promise<TicketDetail | null>;
  /** A comment was published: the ticket the API answered. */
  onCommented: (detail: TicketDetail) => void;
  notify: (message: string, tone?: 'success' | 'info' | 'error') => void;
}

/** Design «Actividad»: a dot, who in bold and what they did. */
function ActivityRow({ line, detail }: { line: ActivityLine; detail: TicketDetail }) {
  const { t } = useTranslation();
  const who = (person: Person) => personLabel(person);
  const emailOf = (userId: string | null) => {
    const person = detail.participants.find((item) => item.user_id === userId);
    return person ? personLabel(person) : (userId ?? '');
  };
  let tone: 'blue' | 'gray' | 'amber' | 'accent' = 'accent';
  let actor: string;
  let action: string;
  let at = '';
  if (line.kind === 'created') {
    tone = 'blue';
    at = formatRelative(line.at);
    if (line.source === 'web' || !line.agent) {
      actor = who(line.actor);
      action = t('tickets.activity.created');
    } else {
      actor = line.agent;
      action = t(
        line.source === 'task'
          ? 'tickets.activity.createdInTask'
          : 'tickets.activity.createdInChat',
        { who: who(line.actor) },
      );
    }
  } else if (line.kind === 'assigned') {
    tone = 'gray';
    actor = who(line.who);
    action = t('tickets.activity.assigned');
  } else if (line.kind === 'approval') {
    tone = 'amber';
    actor = t('tickets.activity.system');
    action = t('tickets.activity.approval');
  } else {
    actor = who(line.actor);
    at = formatRelative(line.at);
    if (line.field === 'status') {
      const status = STATUSES.find((item) => item.key === line.after)?.key ?? 'open';
      action = t('tickets.activity.status', {
        status: t(`tickets.status.${status}`).toLowerCase(),
      });
    } else if (line.field === 'priority') {
      const priority = PRIORITIES.find((item) => item.key === line.after)?.key ?? 'medium';
      action = t('tickets.activity.priority', {
        priority: t(`tickets.priority.${priority}`).toLowerCase(),
      });
    } else if (line.after === null) {
      action = t('tickets.activity.unassigned');
    } else if (line.after === line.actor.user_id) {
      action = t('tickets.activity.assignedSelf');
    } else {
      action = t('tickets.activity.assignedTo', { who: emailOf(line.after) });
    }
  }
  return (
    <div className="tk-act">
      <span className={`tk-dot tk-act-dot-${tone}`} />
      <span>
        <b>{actor}</b> {action}
      </span>
      {at ? <span className="tk-meta">{at}</span> : null}
    </div>
  );
}

/** Design system.jsx `CommentThread` with `markdown`: rendered without raw HTML (ChatMarkdown). */
function Comments({
  api,
  me,
  detail,
  onCommented,
  notify,
}: Pick<Props, 'api' | 'me' | 'onCommented' | 'notify'> & { detail: TicketDetail }) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (event: SyntheticEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    api
      .call('addComment', { path: { ticket_id: detail.ticket_id }, body: { body } })
      .then(
        (next) => {
          setDraft('');
          onCommented(next);
          notify(t('tickets.comments.sent', { id: shortId(detail.ticket_id) }), 'success');
        },
        (failure: unknown) => {
          setError(t(errorKey(failure)));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <div>
      {detail.comments.length === 0 && (
        <div className="tk-cm-empty">{t('tickets.comments.empty')}</div>
      )}
      {detail.comments.length > 0 && (
        <div className="tk-cm-list">
          {detail.comments.map((comment) => {
            const mine = comment.author.user_id === me.user_id;
            const label = personLabel(comment.author);
            return (
              <div key={comment.comment_id} className="tk-cm">
                <span
                  className={mine ? 'sb-user-avatar tk-cm-av is-mine' : 'sb-user-avatar tk-cm-av'}
                  aria-hidden="true"
                >
                  {initialsFor(label)}
                </span>
                <div className="tk-cm-main">
                  <div className="tk-cm-who">
                    <b>{mine ? t('tickets.comments.you') : label}</b>{' '}
                    <span className="tk-cm-at">· {formatRelative(comment.created_at)}</span>
                  </div>
                  <div className="tk-cm-body">
                    <ChatMarkdown>{comment.body}</ChatMarkdown>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <form className="card tk-cm-form" onSubmit={send}>
        <label htmlFor={`${id}-cm`} className="sr-only">
          {t('tickets.comments.label')}
        </label>
        <textarea
          id={`${id}-cm`}
          className="input"
          rows={2}
          maxLength={MAX_COMMENT}
          value={draft}
          placeholder={t('tickets.comments.placeholder')}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {error ? (
          <div className="g-err" role="alert">
            {error}
          </div>
        ) : null}
        <div className="tk-cm-foot">
          <span className="tk-cm-hint">
            {t('tickets.comments.hint')}
            <span>
              {t('tickets.comments.mentions')} <SoonTag />
            </span>
          </span>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!draft.trim() || busy}>
            {t('tickets.comments.send')}
          </button>
        </div>
      </form>
    </div>
  );
}

type Tab = 'comments' | 'activity' | 'tools';

function Body({
  api,
  me,
  detail,
  agents,
  usable,
  onChange,
  onCommented,
  notify,
}: Omit<Props, 'ticketId' | 'onClose'> & { detail: TicketDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('comments');
  const [busy, setBusy] = useState(false);
  const agent = detail.agent_id ? agents.get(detail.agent_id) : undefined;
  // Design: the agent is no longer one the person may use; they see the ticket because they
  // created it or have it assigned (an administrator sees every ticket: no notice then).
  const lost =
    detail.agent_id !== null &&
    usable !== null &&
    !usable.has(detail.agent_id) &&
    (detail.creator.user_id === me.user_id || detail.assignee?.user_id === me.user_id);
  const agentName = agent?.name ?? detail.agent_name;
  const people = assignable(detail, me.user_id);
  const pending = detail.status === 'needs_approval';
  const change = (patch: TicketPatch) => {
    setBusy(true);
    void onChange(detail, patch).finally(() => {
      setBusy(false);
    });
  };
  const tools = detail.source === 'web';
  return (
    <>
      <h2 className="tk-h2">{detail.title}</h2>
      {lost && agentName ? (
        <div className="mc-alert tk-lost">
          <LockIcon size={13} />
          <div>
            {t(
              detail.creator.user_id === me.user_id
                ? 'tickets.panel.lostCreator'
                : 'tickets.panel.lostAssignee',
              { agent: agentName },
            )}
          </div>
        </div>
      ) : null}
      <div className="tk-props">
        <span>{t('tickets.panel.status')}</span>
        <div>
          <select
            className="input tk-sel"
            aria-label={t('tickets.panel.status')}
            value={detail.status}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value as ChosenStatus;
              if (canMoveTo(detail, next)) change({ status: next });
            }}
          >
            {STATUSES.map((status) => (
              <option
                key={status.key}
                value={status.key}
                disabled={status.key !== detail.status && !canMoveTo(detail, status.key)}
              >
                {t(`tickets.status.${status.key}`)}
              </option>
            ))}
          </select>
          {!pending && <div className="mk-meta tk-help">{t('tickets.panel.statusHelp')}</div>}
        </div>
        <span>{t('tickets.panel.priority')}</span>
        <select
          className="input tk-sel"
          aria-label={t('tickets.panel.priority')}
          value={detail.priority}
          disabled={busy}
          onChange={(event) => {
            change({ priority: event.target.value as Priority });
          }}
        >
          {PRIORITIES.map((priority) => (
            <option key={priority.key} value={priority.key}>
              {t(`tickets.priority.${priority.key}`)}
            </option>
          ))}
        </select>
        <span>{t('tickets.panel.assignee')}</span>
        <div>
          <div className="tk-row">
            <select
              className="input tk-sel"
              aria-label={t('tickets.panel.assignee')}
              value={detail.assignee?.user_id ?? ''}
              disabled={busy}
              onChange={(event) => {
                change({ assignee_id: event.target.value || null });
              }}
            >
              <option value="">{t('tickets.unassigned')}</option>
              {people.map((person) => (
                <option key={person.user_id} value={person.user_id}>
                  {person.user_id === me.user_id
                    ? t('tickets.panel.you', { who: person.email ?? me.email ?? me.user_id })
                    : personLabel(person)}
                </option>
              ))}
            </select>
            {detail.assignee?.user_id !== me.user_id && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy}
                onClick={() => {
                  change({ assignee_id: me.user_id });
                }}
              >
                {t('tickets.panel.assignMe')}
              </button>
            )}
          </div>
          <div className="mk-meta tk-help">{t('tickets.panel.assignHelp')}</div>
        </div>
        <span>{t('tickets.panel.agent')}</span>
        {agentName ? (
          lost ? (
            <span className="mk-meta">{agentName}</span>
          ) : (
            <TicketAgent ticket={detail} agent={agent} />
          )
        ) : (
          <span className="mk-meta">—</span>
        )}
        <span>{t('tickets.panel.created')}</span>
        <span>
          {t('tickets.panel.createdLine', {
            age: formatRelative(detail.created_at),
            who: personLabel(detail.creator),
          })}
          {detail.source !== 'web' && agentName ? t('tickets.panel.via', { agent: agentName }) : ''}
        </span>
      </div>

      {pending && (
        <div className="tk-approval">
          <WarnIcon size={14} className="tk-approval-ic" />
          <div className="tk-grow">
            <div className="tk-approval-t">{t('tickets.panel.approvalTitle')}</div>
            <div className="tk-approval-d">
              {t('tickets.panel.approvalBody', {
                agent: agentName ?? t('tickets.panel.approvalAgent'),
              })}
            </div>
            {detail.approval_id ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  void navigate(
                    `/approvals/pending/${encodeURIComponent(detail.approval_id ?? '')}`,
                  );
                }}
              >
                {t('tickets.panel.approvalOpen')} <ArrowRightIcon size={11} />
              </button>
            ) : null}
          </div>
        </div>
      )}

      {detail.description ? <div className="tk-desc">{detail.description}</div> : null}

      <div className="tk-tabs" role="tablist">
        {(['comments', 'activity', 'tools'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'is-on' : ''}
            onClick={() => {
              setTab(key);
            }}
          >
            {key === 'tools' ? (
              tools ? (
                t('tickets.tabs.tools', { count: 0 })
              ) : (
                <>
                  {t('tickets.tabs.toolsSoon')} <SoonTag />
                </>
              )
            ) : (
              t(`tickets.tabs.${key}`)
            )}
          </button>
        ))}
      </div>

      {tab === 'comments' && (
        <Comments api={api} me={me} detail={detail} onCommented={onCommented} notify={notify} />
      )}
      {tab === 'activity' && (
        <div className="tk-activity">
          {activity(detail).map((line, index) => (
            <ActivityRow key={index} line={line} detail={detail} />
          ))}
        </div>
      )}
      {tab === 'tools' &&
        (tools ? (
          <div className="mk-meta tk-trace-empty">{t('tickets.tools.byPerson')}</div>
        ) : (
          <Soon name={t('tickets.tools.soon')} block>
            <div className="mk-meta tk-trace-empty">{t('tickets.tools.soon')}</div>
          </Soon>
        ))}
    </>
  );
}

/**
 * Design `TicketSlideOver`: the ticket the URL names (`/tickets/{id}`), read from the API. A
 * ticket the person may not see answers 404 and reads «No puedes ver este ticket», the same for
 * one that does not exist. Every value is API data rendered as React text; comments are Markdown
 * without raw HTML.
 */
export function TicketPanel(props: Props) {
  const { api, ticketId, onClose, onChange, notify } = props;
  const { t } = useTranslation();
  const titleId = useId();
  const [load, setLoad] = useState<Load>(ticketId ? { kind: 'loading' } : { kind: 'gone' });
  const [attempt, setAttempt] = useState(0);
  const ref = useFocusTrap<HTMLElement>(true, onClose);

  useEffect(() => {
    // The panel is keyed by the URL's id: it starts loading, or «gone» for an invalid id.
    if (ticketId === null) return undefined;
    const controller = new AbortController();
    api.call('getTicket', { path: { ticket_id: ticketId } }, { signal: controller.signal }).then(
      (detail) => {
        setLoad({ kind: 'ready', detail });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const status = (error as { status?: unknown }).status;
        setLoad({ kind: status === 404 || status === 403 ? 'gone' : 'error' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, ticketId, attempt]);

  const ready = load.kind === 'ready' ? load.detail : null;
  const short = ready ? shortId(ready.ticket_id) : null;

  const applyChange = (detail: TicketDetail, patch: TicketPatch) =>
    onChange(detail, patch).then((next) => {
      if (next) setLoad({ kind: 'ready', detail: next });
      return next;
    });

  const commented = (next: TicketDetail) => {
    setLoad({ kind: 'ready', detail: next });
    props.onCommented(next);
  };

  const copy = () => {
    if (!ready) return;
    // The whole id: the API opens a ticket by it, not by its short form (decided 2026-11-05).
    const link = `${window.location.origin}/tickets/${ready.ticket_id}`;
    void navigator.clipboard.writeText(link).then(
      () => {
        notify(t('tickets.panel.linkCopied'), 'success');
      },
      () => {
        notify(t('tickets.panel.linkNotCopied'), 'error');
      },
    );
  };

  let body: ReactNode;
  let footer: ReactNode = null;
  if (load.kind === 'gone') {
    body = (
      <div className="mk-empty tk-panel-state">
        <LockIcon size={18} className="ops-state-lock" />
        <div className="ops-state-t">{t('tickets.panel.goneTitle')}</div>
        <div className="mk-meta">{t('tickets.panel.goneBody')}</div>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          {t('tickets.panel.back')}
        </button>
      </div>
    );
  } else if (load.kind === 'loading') {
    body = (
      <div className="mk-empty tk-panel-state" role="status">
        <span className="spinner" aria-hidden="true" />
        <span className="mk-meta">{t('tickets.panel.loading')}</span>
      </div>
    );
  } else if (load.kind === 'error') {
    body = (
      <div className="mk-empty tk-panel-state" role="alert">
        <WarnIcon size={18} className="ops-state-warn" />
        <div className="ops-state-t">{t('tickets.panel.error')}</div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setLoad({ kind: 'loading' });
            setAttempt((n) => n + 1);
          }}
        >
          <RefreshIcon size={12} /> {t('common.retry')}
        </button>
      </div>
    );
  } else {
    const detail = load.detail;
    body = (
      <Body
        key={detail.ticket_id}
        {...props}
        detail={detail}
        onChange={applyChange}
        onCommented={commented}
      />
    );
    footer =
      detail.status !== 'done' ? (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            void applyChange(detail, { status: 'done' });
          }}
        >
          <CheckIcon size={12} /> {t('tickets.panel.resolve')}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            void applyChange(detail, { status: 'open' });
          }}
        >
          <RefreshIcon size={12} /> {t('tickets.panel.reopen')}
        </button>
      );
  }

  return createPortal(
    <div
      className="overlay overlay-drawer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={ref}
        className="tk-slide"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="tk-slide-h">
          <span id={titleId} className="tk-id tk-slide-id">
            {short ? (
              <>
                {short}
                <span className="sr-only"> {ready?.title}</span>
              </>
            ) : (
              <span className="sr-only">{t('tickets.panel.label')}</span>
            )}
          </span>
          <div className="tk-slide-tools">
            {ready ? (
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                title={t('tickets.panel.copyLink')}
                aria-label={t('tickets.panel.copyLink')}
                onClick={copy}
              >
                <CopyIcon size={13} />
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={t('common.close')}
              onClick={onClose}
            >
              <CloseIcon size={13} />
            </button>
          </div>
        </div>
        <div className="tk-slide-b">{body}</div>
        {footer ? <div className="tk-slide-f">{footer}</div> : null}
      </aside>
    </div>,
    document.body,
  );
}
