import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import type { PendingChange, Units } from '../../api/adminSchemas';
import { diffUnits, isExpired, proposerOf, type OuNode } from '../../lib/businessUnits';
import { CheckIcon, CloseIcon, WarnIcon } from '../icons';
import { DiffView } from './DiffView';
import { fmtDate, rel } from './govFormat';
import { Reason } from './govKit';

interface Props {
  change: PendingChange;
  current: Units;
  currentVersion: number;
  tree: ReadonlyMap<string, OuNode> | null;
  meId: string;
  myArea: string | null;
  busy: boolean;
  now: number;
  onApprove: () => void;
  onReject: () => void;
  onWithdraw: () => void;
}

/**
 * A pending mapping change (design `ProposalCard`). The disabled states only explain what the API
 * will refuse (same_approver, self_edit, expired, version_conflict); the API decides.
 */
export function ProposalCard({
  change,
  current,
  currentVersion,
  tree,
  meId,
  myArea,
  busy,
  now,
  onApprove,
  onReject,
  onWithdraw,
}: Props) {
  const { t } = useTranslation();
  const whyId = useId();
  const diffs = diffUnits(current, change.units);
  const expired = isExpired(change, now);
  const mine = change.proposed_by === meId;
  const stale = change.base_version !== currentVersion;
  const touchesMine = myArea !== null && diffs.some((diff) => diff.area === myArea);
  const expires = fmtDate(change.expires_at);
  const approveWhy = expired
    ? t('settings.areas.card.whyExpired', { date: expires })
    : mine
      ? t('settings.areas.card.whyMine')
      : touchesMine
        ? t('settings.areas.card.whyMyArea', { area: myArea })
        : stale
          ? t('settings.areas.card.whyStale', {
              base: change.base_version,
              current: currentVersion,
            })
          : null;
  const rejectDisabled = touchesMine && !mine;
  const warnTone = stale && !expired && !mine && !touchesMine;

  return (
    <article className={expired ? 'g-card g-prop is-expired' : 'g-card g-prop'}>
      <div className="g-prop-h">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="g-prop-by">
              {mine ? (
                t('settings.areas.card.mine')
              ) : (
                <>
                  {t('settings.areas.card.by')}{' '}
                  <span className="g-email">{proposerOf(change)}</span>
                </>
              )}
            </h3>
            {expired && <span className="badge">{t('settings.areas.card.expired')}</span>}
            {!expired && stale && (
              <span className="badge badge-amber">
                <WarnIcon size={10} className="mr-1" />
                {t('settings.areas.card.stale')}
              </span>
            )}
            {touchesMine && (
              <span className="badge badge-accent">{t('settings.areas.card.touchesMine')}</span>
            )}
          </div>
          <div className="g-meta">
            <span title={fmtDate(change.created_at)}>
              {t('settings.areas.card.created', {
                when: rel(change.created_at, (key, options) => t(key, options), now),
              })}
            </span>
            <span>
              {expired
                ? t('settings.areas.card.expiredOn', { date: expires })
                : t('settings.areas.card.expiresOn', { date: expires })}
            </span>
            <span>{t('settings.areas.card.base', { version: change.base_version })}</span>
            <span className="g-id">{change.change_id}</span>
          </div>
        </div>
        <div className="g-prop-act">
          {mine ? (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={onWithdraw}>
              {t('settings.areas.card.withdraw')}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || rejectDisabled}
                title={rejectDisabled && approveWhy ? approveWhy : undefined}
                aria-describedby={rejectDisabled ? whyId : undefined}
                onClick={onReject}
              >
                <CloseIcon size={11} />
                {t('settings.areas.card.reject')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy || approveWhy !== null}
                title={approveWhy ?? undefined}
                aria-describedby={approveWhy ? whyId : undefined}
                onClick={onApprove}
              >
                <CheckIcon size={12} />
                {t('settings.areas.card.approve')}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="g-motivo">
        <span className="g-diff-k">{t('settings.areas.reason')}</span>
        <p>{change.reason}</p>
      </div>
      <DiffView diffs={diffs} tree={tree} />
      {approveWhy && (
        <div className="g-prop-why">
          <Reason id={whyId} tone={warnTone ? 'warn' : undefined}>
            {approveWhy}
          </Reason>
        </div>
      )}
    </article>
  );
}
