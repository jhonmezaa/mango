import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Reason } from '../../components/admin/govKit';
import { formatRelative } from '../../lib/format';
import { Instructions } from './parts';
import {
  REASON_MAX_LENGTH,
  changedFields,
  lineDiff,
  type Current,
  type Decision,
  type SkillChange,
} from './model';

const STATUS_BADGE: Record<SkillChange['status'], string> = {
  pending: 'badge badge-amber',
  approved: 'badge badge-green',
  rejected: 'badge badge-red',
  withdrawn: 'badge',
  expired: 'badge',
};

/**
 * The body of a pending request (design `SkChangeBody`): what changes and the whole text. In a
 * new version, «Comparar con v{n}» shows a line diff against the approved one. Everything is
 * text: the instructions were written by another person (D92, TM: no HTML).
 */
function ChangeBody({ change, current }: { change: SkillChange; current: Current | null }) {
  const { t } = useTranslation();
  const [comparing, setComparing] = useState(false);
  const fields = current ? changedFields(current, change) : [];
  return (
    <div className="sk-chg-body">
      {fields.map(({ field, before, after }) => (
        <div key={field} className="sk-chg-field">
          <span className="g-diff-k">{t(`skills.changes.fields.${field}`)}</span>{' '}
          <span className="sk-chg-old">{before || '—'}</span> → <span>{after || '—'}</span>
        </div>
      ))}
      {current ? null : (
        <div className="sk-chg-field">
          <span className="g-diff-k">{t('skills.changes.fields.servers')}</span>{' '}
          {change.servers.join(', ') || '—'}
          {change.outputs.length > 0 ? (
            <>
              {' · '}
              <span className="g-diff-k">{t('skills.changes.fields.outputs')}</span>{' '}
              {change.outputs.join(', ')}
            </>
          ) : null}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="g-diff-k">
          {current && comparing
            ? t('skills.changes.instructionsDiff', { version: current.version })
            : current
              ? t('skills.changes.instructionsVersion', { version: change.version })
              : t('skills.changes.instructions')}
        </span>
        {current ? (
          <button
            type="button"
            className="sr-link"
            aria-pressed={comparing}
            onClick={() => {
              setComparing((value) => !value);
            }}
          >
            {comparing
              ? t('skills.changes.fullText')
              : t('skills.changes.compare', { version: current.version })}
          </button>
        ) : null}
      </div>
      {current && comparing ? (
        <pre className="sk-diff mono">
          {lineDiff(current.instructions, change.instructions).map(([kind, line], index) => (
            <div
              // Lines repeat: their place is what identifies them.
              key={index}
              className={kind === '+' ? 'is-add' : kind === '-' ? 'is-rem' : undefined}
            >
              {kind} {line || ' '}
            </div>
          ))}
        </pre>
      ) : (
        <div className="sk-chg-text">
          <Instructions text={change.instructions} />
        </div>
      )}
    </div>
  );
}

/** One line saying what the request does (design `summary` of `S.propose`). */
function Summary({ change, current }: { change: SkillChange; current: Current | null }) {
  const { t } = useTranslation();
  let text: string;
  if (change.version === 1) {
    text = change.duplicate_of
      ? t('skills.changes.summaryCopy', { name: change.duplicate_of.split('@')[0] ?? '' })
      : t('skills.changes.summaryNew');
  } else if (current?.agents) {
    text = t('skills.changes.summaryVersionAgents', {
      count: current.agents,
      version: change.version - 1,
    });
  } else text = t('skills.changes.summaryVersion');
  return <span className="new">{text}</span>;
}

function ChangeItem({
  change,
  current,
  canApprove,
  rejecting,
  onRejecting,
  onDecide,
}: {
  change: SkillChange;
  current: Current | null;
  canApprove: boolean;
  /** Whether this request shows its reject note; the list keeps a single one open. */
  rejecting: boolean;
  onRejecting: (open: boolean) => void;
  /** Resolves to whether it was applied; a failure is shown by the page. */
  onDecide: (decision: Decision) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (rejecting) noteRef.current?.focus();
  }, [rejecting]);
  const who = change.proposed_by_email ?? change.proposed_by;
  const decidedBy = change.decided_by_email ?? change.decided_by;
  const decide = (decision: Decision) => {
    setBusy(true);
    void onDecide(decision).then((done) => {
      setBusy(false);
      if (done && decision.kind === 'reject') onRejecting(false);
    });
  };
  const title =
    change.version === 1
      ? t('skills.changes.titleNew', { name: change.name })
      : t('skills.changes.titleVersion', {
          name: change.name,
          from: change.version - 1,
          to: change.version,
        });

  return (
    <article className="chg">
      <div className="chg-h">
        <div className="chg-main">
          <div className="chg-title-row">
            <span className="chg-t">{title}</span>
            <span className={STATUS_BADGE[change.status]}>
              {t(`skills.changes.status.${change.status}`)}
            </span>
          </div>
          <div className="chg-m">
            <span>{change.own ? t('skills.changes.mine') : t('skills.changes.by', { who })}</span>
            <span>{formatRelative(change.created_at)}</span>
            <span className="mono">{change.change_id.slice(0, 8)}</span>
            {change.status === 'expired' ? <span>{t('skills.changes.expiredMeta')}</span> : null}
            {change.status === 'withdrawn' ? (
              <span>{t('skills.changes.withdrawnBy', { who })}</span>
            ) : null}
            {decidedBy && change.status === 'approved' ? (
              <span>{t('skills.changes.approvedBy', { who: decidedBy })}</span>
            ) : null}
            {decidedBy && change.status === 'rejected' ? (
              <span>{t('skills.changes.rejectedBy', { who: decidedBy })}</span>
            ) : null}
          </div>
        </div>
        {change.status === 'pending' ? (
          <div className="chg-act">
            {change.own ? (
              <>
                <Reason>{t('skills.changes.needsOther')}</Reason>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => {
                    decide({ kind: 'withdraw' });
                  }}
                >
                  {t('skills.changes.withdraw')}
                </button>
              </>
            ) : canApprove ? (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => {
                    setNote('');
                    onRejecting(true);
                  }}
                >
                  {t('skills.changes.reject')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => {
                    decide({ kind: 'approve' });
                  }}
                >
                  {t('skills.changes.approve')}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="chg-diff">
        <Summary change={change} current={current} />
      </div>
      {change.status === 'pending' ? <ChangeBody change={change} current={current} /> : null}
      <div className="chg-why">
        <span className="g-diff-k">{t('skills.changes.reasonLabel')}</span> {change.reason}
      </div>
      {change.note ? (
        <div className="chg-why">
          <span className="g-diff-k">{t('skills.changes.rejectReasonLabel')}</span> {change.note}
        </div>
      ) : null}
      {rejecting ? (
        <div className="g-field chg-reject">
          <textarea
            ref={noteRef}
            className="input"
            rows={2}
            maxLength={REASON_MAX_LENGTH}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
            placeholder={t('skills.changes.rejectPlaceholder')}
            aria-label={t('skills.changes.rejectReasonLabel')}
          />
          <div className="chg-reject-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => {
                onRejecting(false);
              }}
            >
              {t('skills.changes.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || !note.trim()}
              onClick={() => {
                decide({ kind: 'reject', note: note.trim() });
              }}
            >
              {t('skills.changes.reject')}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * Requests of new skills or new versions (design `ChangeList kind="skill"`). Whoever proposed
 * only withdraws; another administrator approves or rejects. The API decides each action
 * (`ApproveSkill`, `ProposeSkill`); `can_approve` and `own` only choose the buttons.
 */
export function SkillChangeList({
  title,
  changes,
  current,
  canApprove,
  onDecide,
}: {
  title: string;
  changes: readonly SkillChange[];
  /** The approved version of the skill (detail); null for requests of new skills. */
  current: Current | null;
  canApprove: boolean;
  onDecide: (change: SkillChange, decision: Decision) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [rejecting, setRejecting] = useState<string | null>(null);
  if (!changes.length) return null;
  return (
    <section className="sk-changes">
      <div className="g-sec-t">{title}</div>
      <div className="g-sec-meta">{t('skills.changes.note')}</div>
      <div className="chg-list">
        {changes.map((change) => (
          <ChangeItem
            key={change.change_id}
            change={change}
            current={current}
            canApprove={canApprove}
            rejecting={rejecting === change.change_id}
            onRejecting={(open) => {
              setRejecting(open ? change.change_id : null);
            }}
            onDecide={(decision) => onDecide(change, decision)}
          />
        ))}
      </div>
    </section>
  );
}
