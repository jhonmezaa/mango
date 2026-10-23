import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { adminErrorKey, apiErrorCode } from '../../api/adminErrors';
import type { ApiClient } from '../../api/client';
import type { Me } from '../../api/schemas';
import { Badge } from '../../components/Badge';
import {
  ArrowRightIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronRightIcon,
  LockIcon,
} from '../../components/icons';
import { formatRelative } from '../../lib/format';
import { NOTE_MAX_LENGTH, personOf } from './model';
import {
  SOURCE_TONE,
  closedAt,
  knowledgePath,
  locationOf,
  needsMe,
  useSourceTitle,
  type QueuedSource,
} from './sources';

type Notify = (message: string, tone?: 'success' | 'info') => void;

const REJECT_REASONS = ['folder', 'data', 'duplicate'] as const;
const OWN_ERRORS = new Set(['own_proposal', 'source_decided', 'note_required', 'secret_in_note']);
type OwnError = 'own_proposal' | 'source_decided' | 'note_required' | 'secret_in_note';

function isOwnError(code: string | null): code is OwnError {
  return code !== null && OWN_ERRORS.has(code);
}

/** A row of the queue (design `KbSourceRow`). */
export function SourceRow({
  source,
  active,
  narrow,
  onSelect,
}: {
  source: QueuedSource;
  active: boolean;
  narrow: boolean;
  onSelect: (source: QueuedSource) => void;
}) {
  const { t } = useTranslation();
  const title = useSourceTitle();
  const classes = ['card', 'ap-row'];
  if (active) classes.push('is-active');
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={classes.join(' ')}
      onClick={() => {
        onSelect(source);
      }}
    >
      <span className="mk-avatar sm kb-req-av">
        <BookOpenIcon size={14} />
      </span>
      <span className="ap-row-main">
        <span className="ap-row-t">{title(source)}</span>
        <span className="ap-row-s">
          {t('approvals.sources.rowSub', {
            id: source.src_id,
            who: personOf(source.proposed_by.email, source.proposed_by.user_id),
            when: formatRelative(source.proposed_at),
          })}
        </span>
        <span className="ap-row-badges">
          <Badge>{t('approvals.sources.badge')}</Badge>
          {source.status !== 'pending' ? (
            <Badge tone={SOURCE_TONE[source.status]}>
              {t(`approvals.sources.status.${source.status}`)}
            </Badge>
          ) : null}
        </span>
      </span>
      {needsMe(source) ? (
        <span
          className="ap-dot"
          role="img"
          title={t('approvals.sources.waitsYou')}
          aria-label={t('approvals.sources.waitsYou')}
        />
      ) : null}
      {narrow ? <ChevronRightIcon size={14} className="ap-row-go" /> : null}
    </button>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}

/** What a proposal is (design `KbSourceFacts`). `compact`: the card of the Bandeja. */
export function SourceFacts({
  source,
  compact = false,
}: {
  source: QueuedSource;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="ap-facts">
      <Fact label={t('approvals.sources.knowledgeBase')}>
        {source.knowledge_base} <span className="mono mk-meta">{source.kb_id}</span>
      </Fact>
      <Fact
        label={source.replaces ? t('approvals.sources.bucketNew') : t('approvals.sources.bucket')}
      >
        <span className="mono [overflow-wrap:anywhere]">{locationOf(source)}</span>
      </Fact>
      {source.replaces ? (
        <Fact label={t('approvals.sources.readsNow')}>
          <span className="mono [overflow-wrap:anywhere]">{source.replaces}</span>
        </Fact>
      ) : null}
      <Fact label={t('approvals.sources.proposed')}>
        {t('approvals.sources.proposedValue', {
          who: personOf(source.proposed_by.email, source.proposed_by.user_id),
          when: formatRelative(source.proposed_at),
        })}
      </Fact>
      <Fact label={t('approvals.sources.groups')}>
        <span className="mono [overflow-wrap:anywhere]">{source.groups.join(', ')}</span>
      </Fact>
      {!compact ? (
        <Fact label={t('approvals.sources.frequency')}>
          {t(`knowledge.freqs.${source.sync_schedule as 'manual' | '6h' | 'daily' | 'weekly'}`, {
            defaultValue: source.sync_schedule,
          })}
        </Fact>
      ) : null}
      <Fact label={t('approvals.sources.checked')}>{t('approvals.sources.checkedValue')}</Fact>
    </div>
  );
}

/**
 * Approve (optional note) or reject (required reason) a proposal, or withdraw one's own (design
 * `KbSourceDecision`, D88 (42)). The API decides who may: these buttons follow its `can_decide`.
 */
export function SourceDecision({
  api,
  me,
  source,
  compact = false,
  notify,
  onChanged,
}: {
  api: ApiClient;
  me: Me;
  source: QueuedSource;
  compact?: boolean;
  notify: Notify;
  /** Reads the queue again after a decision. */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = { kb_id: source.kb_id, src_id: source.src_id };
  const fieldId = `kbs-note-${source.src_id}`;

  const run = async (action: () => Promise<unknown>, toast: string, tone: 'success' | 'info') => {
    setBusy(true);
    setError(null);
    try {
      await action();
      notify(toast, tone);
      setMode(null);
      setNote('');
      onChanged();
    } catch (failure) {
      const code = apiErrorCode(failure);
      setError(
        isOwnError(code) ? t(`approvals.sources.errors.${code}`) : t(adminErrorKey(failure)),
      );
      if (code === 'source_decided' || code === 'version_conflict') onChanged();
    } finally {
      setBusy(false);
    }
  };

  if (source.status !== 'pending') {
    const who =
      source.status === 'withdrawn'
        ? personOf(source.proposed_by.email, source.proposed_by.user_id)
        : personOf(source.decided_by?.email, source.decided_by?.user_id);
    const at = closedAt(source);
    return (
      <div className="ap-closed">
        <Badge tone={SOURCE_TONE[source.status]}>
          {t(`approvals.sources.status.${source.status}`)}
        </Badge>
        {at ? t('approvals.sources.closedBy', { who, when: formatRelative(at) }) : null}
        {source.note ? t('approvals.sources.closedNote', { note: source.note }) : null}
      </div>
    );
  }
  if (source.proposed_by.user_id === me.user_id) {
    return (
      <div className="ap-decision">
        <div className="ap-actions">
          <span className="ap-reason ap-own">
            <LockIcon size={12} /> {t('approvals.sources.own')}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              void run(
                () => api.call('deleteSource', { path, body: { version: source.version } }),
                t('approvals.sources.toastWithdrawn'),
                'info',
              );
            }}
          >
            {t('approvals.sources.withdraw')}
          </button>
        </div>
        {error ? (
          <div className="ap-field-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    );
  }
  if (!source.can_decide) {
    return (
      <div className="ap-reason">
        <LockIcon size={12} /> {t('approvals.sources.waitAdmin')}
      </div>
    );
  }

  const approve = () => {
    const text = note.trim();
    void run(
      () =>
        api.call('approveSource', {
          path,
          body: { version: source.version, ...(text ? { note: text } : {}) },
        }),
      t('approvals.sources.toastApproved'),
      'success',
    );
  };
  const reject = () => {
    setTried(true);
    const text = note.trim();
    if (!text) return;
    void run(
      () => api.call('rejectSource', { path, body: { version: source.version, note: text } }),
      t('approvals.sources.toastRejected'),
      'info',
    );
  };
  const back = () => {
    setMode(null);
    setNote('');
    setTried(false);
    setError(null);
  };
  const missing = tried && !note.trim();

  return (
    <div className="ap-decision">
      {mode === 'reject' ? (
        <>
          <label htmlFor={fieldId}>{t('approvals.sources.rejectReason')}</label>
          <div className="ap-chips">
            {REJECT_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                className="tk-chip"
                onClick={() => {
                  setNote(t(`approvals.sources.reasons.${reason}`));
                }}
              >
                {t(`approvals.sources.reasons.${reason}`)}
              </button>
            ))}
          </div>
          <textarea
            id={fieldId}
            className={missing ? 'input has-error' : 'input'}
            rows={2}
            maxLength={NOTE_MAX_LENGTH}
            value={note}
            placeholder={t('approvals.sources.rejectPlaceholder')}
            aria-invalid={missing}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
          {missing ? (
            <div className="ap-field-error" role="alert">
              {t('approvals.sources.rejectRequired')}
            </div>
          ) : null}
        </>
      ) : null}
      {mode === 'approve' ? (
        <>
          <label htmlFor={fieldId}>
            {t('approvals.sources.noteLabel')}{' '}
            <span className="ap-optional">{t('approvals.sources.optional')}</span>
          </label>
          <textarea
            id={fieldId}
            className="input"
            rows={2}
            maxLength={NOTE_MAX_LENGTH}
            value={note}
            placeholder={t('approvals.sources.notePlaceholder')}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </>
      ) : null}
      {error ? (
        <div className="ap-field-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="ap-actions">
        {mode === null ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={
                compact
                  ? approve
                  : () => {
                      setMode('approve');
                    }
              }
            >
              <CheckIcon size={12} /> {t('approvals.sources.approve')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => {
                setMode('reject');
              }}
            >
              {t('approvals.sources.reject')}
            </button>
          </>
        ) : mode === 'approve' ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={approve}
            >
              <CheckIcon size={12} /> {t('approvals.sources.confirmApprove')}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={back}>
              {t('approvals.sources.cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-sm mk-danger" disabled={busy} onClick={reject}>
              {t('approvals.sources.confirmReject')}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={back}>
              {t('approvals.sources.cancel')}
            </button>
          </>
        )}
        {!compact ? (
          <span className="mk-meta ap-as">
            {t('approvals.sources.signsAs', { who: me.email ?? me.user_id })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The body of a proposal in the detail of Aprobaciones (design `KbSourceDetail`). */
export function SourceBody({ source }: { source: QueuedSource }) {
  const { t } = useTranslation();
  const title = useSourceTitle();
  const proposer = personOf(source.proposed_by.email, source.proposed_by.user_id);
  const decider = personOf(source.decided_by?.email, source.decided_by?.user_id);
  const timeline: { key: string; who: string; what: string; when: string | null; tone: string }[] =
    [
      {
        key: 'proposed',
        who: proposer,
        what: source.replaces
          ? t('approvals.sources.proposedChange')
          : t('approvals.sources.proposedNew'),
        when: formatRelative(source.proposed_at),
        tone: 'dot-blue',
      },
    ];
  const at = closedAt(source);
  if (source.status === 'approved' && at) {
    timeline.push({
      key: 'approved',
      who: decider,
      what: source.note
        ? t('approvals.sources.approvedNote', { note: source.note })
        : t('approvals.sources.approved'),
      when: formatRelative(at),
      tone: 'dot-green',
    });
  }
  if (source.status === 'rejected' && at) {
    timeline.push({
      key: 'rejected',
      who: decider,
      what: source.note
        ? t('approvals.sources.rejected', { note: source.note })
        : t('approvals.sources.rejectedNoNote'),
      when: formatRelative(at),
      tone: 'dot-red',
    });
  }
  if (source.status === 'withdrawn') {
    timeline.push({
      key: 'withdrawn',
      who: proposer,
      what: t('approvals.sources.withdrawn'),
      when: at ? formatRelative(at) : null,
      tone: 'dot-gray',
    });
  }
  return (
    <div className="ap-sections">
      <div>
        <h2 className="ap-h2">{title(source)}</h2>
        <p className="ap-impact">
          {source.replaces ? t('approvals.sources.impactChange') : t('approvals.sources.impactNew')}
        </p>
      </div>
      <SourceFacts source={source} />
      <div className="mk-meta leading-normal">{t('approvals.sources.note')}</div>
      <div>
        <div className="mk-sec-t">{t('approvals.sources.history')}</div>
        <div className="tk-activity">
          {timeline.map((entry) => (
            <div key={entry.key} className="tk-act">
              <span className={`dot tk-dot ${entry.tone}`} aria-hidden="true" />
              <span>
                <b>{entry.who}</b> {entry.what}
              </span>
              {entry.when ? <span className="tk-meta">{entry.when}</span> : null}
            </div>
          ))}
        </div>
      </div>
      <Link className="btn btn-sm self-start" to={knowledgePath(source)}>
        {t('approvals.sources.openKb')} <ArrowRightIcon size={11} />
      </Link>
    </div>
  );
}
