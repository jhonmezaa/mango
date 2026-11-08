import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { OperationOutput } from '../../api/operations';
import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { Badge, type BadgeTone } from '../../components/Badge';
import { Skel } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import { ErrorState } from '../../components/ErrorState';
import { InfoIcon, MemoryIcon, TrashIcon, WarnIcon } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { RateWaitButton, RateWaitLine } from '../../components/RateWait';
import { Topbar } from '../../components/Topbar';
import { formatDate } from '../../lib/format';

type MemoryOut = OperationOutput<'getMemory'>;
type MemoryRecord = MemoryOut['records'][number];
type Kind = MemoryRecord['kind'];

const KINDS: readonly Kind[] = ['preferences', 'facts', 'summaries'];
const KIND_TONE: Record<Kind, BadgeTone> = {
  preferences: 'blue',
  facts: 'neutral',
  summaries: 'violet',
};
/** Without `Retry-After`, the wait of the route's limit (30 per minute). */
const DEFAULT_WAIT_S = 60;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: MemoryOut }
  | { kind: 'unavailable' }
  | { kind: 'rate'; until: number };

const waitUntil = (error: ApiError) => Date.now() + (error.retryAfter ?? DEFAULT_WAIT_S) * 1000;

/**
 * Memoria (D122, design round 41 memory.jsx `MemoryView`): what the agents remember of the person,
 * read from GET /api/memory, which answers only the caller's records. Each record is text a model
 * extracted from the person's conversations (TM-ME10): rendered as plain text, never as HTML or
 * Markdown. Deleting asks in the row itself and «Borrar todo» in its own dialog, never with a
 * browser dialog.
 */
export function MemoryPage() {
  const { t } = useTranslation();
  const { api, agents } = useSession();
  const { notify, stack } = useToasts();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [agent, setAgent] = useState<string>('all');
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [ask, setAsk] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [allOpen, setAllOpen] = useState(false);

  // Only from the request's callbacks: the first state is already «loading».
  const fetchMemory = useCallback(() => {
    api.call('getMemory').then(
      (data) => {
        setState({ kind: 'ready', data });
      },
      (error: unknown) => {
        setState(
          error instanceof ApiError && error.status === 429
            ? { kind: 'rate', until: waitUntil(error) }
            : { kind: 'unavailable' },
        );
      },
    );
  }, [api]);

  useEffect(() => {
    fetchMemory();
  }, [fetchMemory]);

  const load = () => {
    setState({ kind: 'loading' });
    fetchMemory();
  };

  const names = useMemo(
    () => new Map((agents ?? []).map((item) => [item.id, item.name] as const)),
    [agents],
  );
  const agentName = (id: string) => names.get(id) ?? id;

  const failed = (error: unknown) => {
    if (error instanceof ApiError && error.status === 429) {
      notify(t('memory.rate.body'), 'warn', t('memory.rate.title'));
    } else {
      notify(t(error instanceof ApiError ? 'errors.generic' : 'errors.network'), 'error');
    }
  };

  const removeLocal = (ids: ReadonlySet<string> | null) => {
    setState((current) => {
      if (current.kind !== 'ready') return current;
      const records = ids ? current.data.records.filter((r) => !ids.has(r.record_id)) : [];
      const total = ids ? Math.max(0, current.data.total - ids.size) : 0;
      return {
        kind: 'ready',
        data: { ...current.data, records, total, complete: ids ? current.data.complete : true },
      };
    });
  };

  const deleteOne = (record: MemoryRecord) => {
    setBusy(record.record_id);
    api.deleteMemoryRecord(record.record_id).then(
      () => {
        setBusy(null);
        setAsk(null);
        removeLocal(new Set([record.record_id]));
        notify(t('memory.deleted'));
      },
      (error: unknown) => {
        setBusy(null);
        // Already gone (or never the caller's: the API answers the same 404): it is not
        // remembered either way.
        if (error instanceof ApiError && error.status === 404) {
          setAsk(null);
          removeLocal(new Set([record.record_id]));
          notify(t('memory.deleted'));
          return;
        }
        failed(error);
      },
    );
  };

  const deleteAll = () => {
    setBusy('all');
    api.call('deleteMemory').then(
      (deleted) => {
        setBusy(null);
        setAllOpen(false);
        removeLocal(null);
        notify(t('memory.allDeleted', { records: deleted.records, events: deleted.events }));
      },
      (error: unknown) => {
        setBusy(null);
        failed(error);
      },
    );
  };

  let body;
  let data: MemoryOut | null = null;
  if (state.kind === 'loading') {
    body = (
      <div className="card" aria-busy="true" aria-label={t('memory.loading')}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="mm-row">
            <div className="mm-skel">
              <Skel w={70} h={16} />
              <Skel w={`${String(90 - i * 12)}%`} />
              <Skel w="30%" h={10} />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (state.kind === 'unavailable') {
    body = (
      <ErrorState
        icon={WarnIcon}
        headingLevel="h2"
        title={t('memory.unavailable.title')}
        description={t('memory.unavailable.body')}
        actions={
          <button type="button" className="btn btn-sm" onClick={load}>
            {t('errors.retry')}
          </button>
        }
      />
    );
  } else if (state.kind === 'rate') {
    body = (
      <div className="mc-alert amber" role="alert">
        <WarnIcon size={14} />
        <div className="flex-1">
          <b>{t('memory.rate.title')}</b> {t('memory.rate.body')}{' '}
          <RateWaitLine until={state.until} />
        </div>
        <RateWaitButton until={state.until} onRetry={load} />
      </div>
    );
  } else if (!state.data.enabled) {
    body = <EmptyState title={t('memory.off.title')} text={t('memory.off.body')} role="status" />;
  } else if (state.data.records.length === 0) {
    body = <EmptyState title={t('memory.empty.title')} text={t('memory.empty.body')} />;
  } else {
    data = state.data;
    const { records, total } = data;
    const over = !data.complete;
    const agentIds = [...new Set(records.map((r) => r.agent_id))];
    const list = records.filter(
      (r) => (agent === 'all' || r.agent_id === agent) && (kind === 'all' || r.kind === kind),
    );
    body = (
      <>
        {over && (
          <div className="mc-alert" role="status">
            <InfoIcon size={14} />
            <div>
              {t('memory.over', {
                shown: records.length.toLocaleString('es'),
                total: total.toLocaleString('es'),
              })}
            </div>
          </div>
        )}
        <div className="mm-bar">
          <select
            className="input mk-sel"
            value={agent}
            aria-label={t('memory.agent')}
            onChange={(event) => {
              setAgent(event.target.value);
            }}
          >
            <option value="all">{t('memory.allAgents')}</option>
            {agentIds.map((id) => (
              <option key={id} value={id}>
                {agentName(id)}
              </option>
            ))}
          </select>
          <div className="tk-quick" role="group" aria-label={t('memory.kindLabel')}>
            {(['all', ...KINDS] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={kind === key ? 'is-on' : ''}
                aria-pressed={kind === key}
                onClick={() => {
                  setKind(key);
                }}
              >
                {t(`memory.kinds.${key}`)}
              </button>
            ))}
          </div>
          <span className="mk-meta mm-count">
            {list.length === records.length
              ? t('memory.count', { count: total, formatted: total.toLocaleString('es') })
              : t('memory.countOf', {
                  shown: list.length.toLocaleString('es'),
                  total: total.toLocaleString('es'),
                })}
          </span>
          <button
            type="button"
            className="btn btn-sm mk-danger"
            onClick={() => {
              setAllOpen(true);
            }}
          >
            <TrashIcon size={11} /> {t('memory.deleteAll')}
          </button>
        </div>
        {list.length === 0 ? (
          <div className="mk-empty">
            <div className="mm-empty-t">{t('memory.noMatch')}</div>
            <div className="mk-meta">{t('memory.noMatchHint')}</div>
          </div>
        ) : (
          <ul className="card mm-list m-0 list-none p-0">
            {list.map((record) => (
              <MemoryRow
                key={record.record_id}
                record={record}
                agentName={agentName(record.agent_id)}
                asking={ask === record.record_id}
                busy={busy === record.record_id}
                onAsk={() => {
                  setAsk(record.record_id);
                }}
                onCancel={() => {
                  setAsk(null);
                }}
                onDelete={() => {
                  deleteOne(record);
                }}
              />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <>
      <Topbar crumbs={[t('memory.title')]} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('memory.title')}</h1>
          <p className="page-subtitle">{t('memory.subtitle')}</p>
        </div>
        <div className="mm-wrap">
          {body}
          <div className="mm-foot">
            <InfoIcon size={12} />
            <span>{t('memory.foot')}</span>
          </div>
        </div>
      </div>
      {allOpen && data && (
        <Modal
          title={t('memory.allTitle')}
          busy={busy === 'all'}
          onClose={() => {
            setAllOpen(false);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn-sm"
                data-autofocus
                disabled={busy === 'all'}
                onClick={() => {
                  setAllOpen(false);
                }}
              >
                {t('memory.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-sm mk-danger"
                disabled={busy === 'all'}
                onClick={deleteAll}
              >
                {busy === 'all' ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> {t('memory.deleting')}
                  </>
                ) : (
                  t('memory.allConfirm')
                )}
              </button>
            </>
          }
        >
          <p className="mm-modal-body">
            {t('memory.allBody', {
              count: data.total,
              formatted: data.total.toLocaleString('es'),
              hidden: data.complete ? '' : t('memory.allHidden'),
            })}
          </p>
        </Modal>
      )}
      {stack}
    </>
  );
}

function EmptyState({ title, text, role }: { title: string; text: string; role?: 'status' }) {
  return (
    <div className="mm-empty" role={role}>
      <span className="mm-empty-ic">
        <MemoryIcon size={20} />
      </span>
      <h2 className="mm-empty-t">{title}</h2>
      <p>{text}</p>
    </div>
  );
}

function MemoryRow({
  record,
  agentName,
  asking,
  busy,
  onAsk,
  onCancel,
  onDelete,
}: {
  record: MemoryRecord;
  agentName: string;
  asking: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className={asking ? 'mm-row is-ask' : 'mm-row'}>
      <div className="min-w-0 flex-1">
        <div className="mm-row-head">
          <Badge tone={KIND_TONE[record.kind]}>{t(`memory.kind.${record.kind}`)}</Badge>
          <span className="mk-meta">
            {agentName} · {formatDate(record.created_at)}
          </span>
        </div>
        {/* Text a model extracted from conversations (TM-ME10): plain text, never HTML. */}
        <div className="mm-text">
          {record.text}
          {record.truncated ? '…' : ''}
        </div>
        {record.truncated && <div className="mk-meta mm-trunc">{t('memory.truncated')}</div>}
        {asking && (
          <div className="mm-ask" role="group" aria-label={t('memory.confirmLabel')}>
            <span className="mk-meta">{t('memory.confirmOne', { agent: agentName })}</span>
            <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
              {t('memory.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-sm mk-danger"
              onClick={onDelete}
              disabled={busy}
            >
              {busy ? (
                <>
                  <span className="spinner" aria-hidden="true" /> {t('memory.deleting')}
                </>
              ) : (
                t('memory.delete')
              )}
            </button>
          </div>
        )}
      </div>
      {!asking && (
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={t('memory.deleteOne')}
          title={t('memory.deleteOneTitle')}
          onClick={onAsk}
        >
          <TrashIcon size={12} />
        </button>
      )}
    </li>
  );
}
