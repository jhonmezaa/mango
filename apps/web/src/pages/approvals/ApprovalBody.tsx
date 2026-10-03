import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { Me } from '../../api/schemas';
import { ChatIcon } from '../../components/icons';
import { formatRelative } from '../../lib/format';
import {
  argumentEntries,
  canExpire,
  isWaiting,
  leftText,
  minutesLeft,
  personOf,
  ruleText,
  wasApproved,
  type Approval,
} from './model';

interface TimelineEntry {
  key: string;
  who: string;
  what: string;
  when?: string;
  tone: 'blue' | 'amber' | 'green' | 'red' | 'muted';
}

const TONE_CLASS: Record<TimelineEntry['tone'], string> = {
  blue: 'dot-blue',
  amber: 'dot-amber',
  green: 'dot-green',
  red: 'dot-red',
  muted: 'dot-gray',
};

/** Design `timeline`: who asked, why it was held, each signature and how it ended. */
function useTimeline(approval: Approval, me: Me, now: number): TimelineEntry[] {
  const { t } = useTranslation();
  const name = (email: string | null | undefined, id: string | null | undefined) =>
    id === me.user_id ? t('approvals.detail.you') : personOf(email, id);
  const agent = approval.agent_name ?? t('approvals.agentUnknown', { id: approval.agent_id });
  const entries: TimelineEntry[] = [
    {
      key: 'asked',
      who: name(approval.requested_by_email, approval.requested_by),
      what: t('approvals.detail.asked', { agent }),
      when: formatRelative(approval.created_at, now),
      tone: 'blue',
    },
    {
      key: 'held',
      who: t('approvals.detail.system'),
      what: t('approvals.detail.held', { rule: ruleText(t, approval) }),
      tone: 'amber',
    },
  ];
  const { status } = approval;
  const approvedOnce = wasApproved(approval);
  const requester = name(approval.requested_by_email, approval.requested_by);
  const lastSignature = approval.signatures.length - 1;
  approval.signatures.forEach((signature, index) => {
    // Design: the signature that completes the approval reads «aprobó»; the others, «firmó».
    const closes = approvedOnce && index === lastSignature;
    const what = !closes
      ? signature.note
        ? t('approvals.detail.signedNote', { note: signature.note })
        : t('approvals.detail.signed')
      : status !== 'approved'
        ? t('approvals.detail.approved')
        : approval.mine
          ? t('approvals.detail.approvedWaitingYou')
          : t('approvals.detail.approvedWaiting', {
              who: personOf(approval.requested_by_email, approval.requested_by),
            });
    entries.push({
      key: `signature-${index}`,
      who: name(signature.email, signature.user_id),
      what,
      when: formatRelative(signature.at, now),
      tone: 'green',
    });
  });
  const decider = name(approval.decided_by_email, approval.decided_by);
  const when = approval.decided_at ? formatRelative(approval.decided_at, now) : undefined;
  const closing = (what: string, tone: TimelineEntry['tone'], who = decider): TimelineEntry => ({
    key: 'closing',
    who,
    what,
    tone,
    ...(when ? { when } : {}),
  });
  const ran = (what: string, tone: TimelineEntry['tone']): TimelineEntry => ({
    key: 'ran',
    who: requester,
    what,
    tone,
    ...(approval.executed_at ? { when: formatRelative(approval.executed_at, now) } : {}),
  });
  const system = t('approvals.detail.system');
  if (
    approval.tier === 'self' &&
    ['approved', 'executing', 'executed', 'failed'].includes(status)
  ) {
    entries.push({ ...closing(t('approvals.detail.confirmed'), 'green'), key: 'confirmed' });
  }
  if (status === 'executing') {
    entries.push({
      key: 'ran',
      who: requester,
      what: t('approvals.detail.executing'),
      when: t('approvals.detail.now'),
      tone: 'blue',
    });
  } else if (status === 'executed') {
    entries.push(ran(t('approvals.detail.executed'), 'green'));
  } else if (status === 'failed') {
    entries.push(ran(t('approvals.detail.failed', { code: approval.error ?? 'error' }), 'red'));
  } else if (status === 'rejected') {
    entries.push(
      closing(
        approval.note
          ? t('approvals.detail.rejectedNote', { note: approval.note })
          : t('approvals.detail.rejected'),
        'red',
      ),
    );
  } else if (status === 'cancelled') {
    entries.push(closing(t('approvals.detail.cancelled'), 'muted', decider || system));
  } else if (status === 'expired') {
    entries.push({
      key: 'closing',
      who: system,
      what: approvedOnce ? t('approvals.detail.expiredApproved') : t('approvals.detail.expired'),
      tone: 'muted',
    });
  }
  return entries;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * Detail of a request (design `ApprovalBody`). The title is what the tool does according to the
 * release's manifest and the arguments are the ones the API stored: nothing here is the model's
 * description of the action (R3). Every value is rendered as React text.
 */
export function ApprovalBody({ approval, me, now }: { approval: Approval; me: Me; now: number }) {
  const { t } = useTranslation();
  const timeline = useTimeline(approval, me, now);
  const waiting = isWaiting(approval);
  const expires = canExpire(approval);
  const needed = approval.approvals_needed;
  const given = approval.signatures.length;
  const done = wasApproved(approval);
  const args = argumentEntries(approval);
  const soon = expires && minutesLeft(approval, now) < 60;
  return (
    <div className="ap-sections">
      <div>
        <h2 className="ap-h2">{approval.description || approval.tool}</h2>
      </div>
      <div className="ap-facts">
        <Fact label={t('approvals.detail.agent')}>
          {approval.agent_name ?? t('approvals.agentUnknown', { id: approval.agent_id })}
        </Fact>
        <Fact label={t('approvals.detail.requester')}>
          {t('approvals.detail.requesterAt', {
            who: personOf(approval.requested_by_email, approval.requested_by),
            when: formatRelative(approval.created_at, now),
          })}
        </Fact>
        <Fact label={t('approvals.detail.policy')}>{ruleText(t, approval)}</Fact>
        <Fact label={t('approvals.detail.signatures')}>
          {approval.tier === 'self' ? (
            t('approvals.detail.selfTier')
          ) : (
            <>
              <span className="ap-sigs" aria-hidden="true">
                {Array.from({ length: needed }, (_, index) => (
                  <i key={index} className={index < given || done ? 'on' : undefined} />
                ))}
              </span>
              {t('approvals.detail.signaturesOf', {
                given: done ? needed : Math.min(needed, given),
                needed,
              })}
              {needed > 1 && waiting ? t('approvals.detail.distinct') : null}
            </>
          )}
        </Fact>
        {expires ? (
          <Fact label={t('approvals.detail.expiry')}>
            <span className={soon ? 'text-danger' : undefined}>
              {t(waiting ? 'approvals.detail.expirySign' : 'approvals.detail.expiryRun', {
                left: leftText(t, approval, now),
              })}
            </span>
          </Fact>
        ) : null}
      </div>
      <div>
        <div className="mk-sec-t">{t('approvals.detail.what')}</div>
        <div className="ap-call">
          <div className="mono ap-call-t">{approval.tool}</div>
          <div className="ap-params">
            {args.length === 0 ? (
              <div>
                <span>{t('approvals.detail.noArguments')}</span>
                <span />
              </div>
            ) : (
              args.map(([key, value]) => (
                <div key={key}>
                  <span className="mono">{key}</span>
                  <span className="mono">{value}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      <div>
        <div className="mk-sec-t">{t('approvals.detail.history')}</div>
        <div className="tk-activity">
          {timeline.map((entry) => (
            <div key={entry.key} className="tk-act">
              <span className={`dot tk-dot ${TONE_CLASS[entry.tone]}`} aria-hidden="true" />
              <span>
                <b>{entry.who}</b> {entry.what}
              </span>
              {entry.when ? <span className="tk-meta">{entry.when}</span> : null}
            </div>
          ))}
        </div>
      </div>
      {approval.conversation_id ? (
        // An internal route built from API data: the id is encoded, never trusted as a path.
        <Link
          className="btn btn-sm self-start"
          to={`/c/${encodeURIComponent(approval.conversation_id)}`}
        >
          <ChatIcon size={12} /> {t('approvals.detail.openChat')}
        </Link>
      ) : null}
    </div>
  );
}
