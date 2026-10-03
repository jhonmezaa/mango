import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { formatRelative } from '../../lib/format';
import { Badge, type BadgeTone } from '../Badge';
import { ArrowRightIcon } from '../icons';
import { AgentAvatar } from './AgentAvatar';
import { builderPath, mineStatus, type MineItem, type MineStatus } from './model';

const STATUS_TONE: Record<MineStatus, BadgeTone> = {
  draft: 'neutral',
  review: 'amber',
  rejected: 'red',
  approved: 'blue',
  failed: 'red',
};

/** The date the design shows for each status. */
function whenOf(item: MineItem, status: MineStatus): string {
  if (status === 'review') return item.submitted_at ?? item.updated_at;
  if (status === 'rejected') return item.rejected_at ?? item.updated_at;
  return item.updated_at;
}

interface Props {
  mine: readonly MineItem[];
  /** Versions of other creators waiting for this admin's review. */
  othersReview: number;
}

/**
 * «Tus agentes en curso» (design marketplace.jsx `MkInProgress`): the user's own drafts and
 * versions on their way to publication, each one a link to the Agent Builder. Names and rejection
 * reasons are written by people: rendered as text.
 */
export function InProgress({ mine, othersReview }: Props) {
  const { t } = useTranslation();
  return (
    <section className="mk-group mk-inprogress">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 className="mk-group-h m-0">
          {t('marketplace.inProgress.title')} <span>{mine.length}</span>
        </h2>
        {othersReview > 0 ? (
          <Link className="sr-link" to="/review">
            {t('marketplace.inProgress.othersReview', { count: othersReview })}
          </Link>
        ) : null}
      </div>
      {mine.length > 0 ? (
        <div className="card mk-ip-list">
          {mine.map((item) => {
            const status = mineStatus(item);
            const detail = [
              t(`marketplace.inProgress.when.${status}`, {
                when: formatRelative(whenOf(item, status)),
              }),
              status === 'rejected' && item.rejection_reason
                ? t('marketplace.inProgress.reason', { reason: item.rejection_reason })
                : '',
              status === 'failed' && item.failed_step
                ? t('marketplace.inProgress.failedStep', { step: item.failed_step })
                : '',
            ].join('');
            return (
              <Link
                key={`${item.agent_id}/${String(item.version)}`}
                className="mk-ip"
                to={builderPath.version(item.agent_id, item.version)}
              >
                <AgentAvatar icon={item.icon} size="sm" muted />
                <span className="min-w-0 flex-1">
                  <span className="mk-name block">
                    {item.name}
                    {item.base_version !== null ? (
                      <span className="mk-meta font-normal">
                        {t('marketplace.inProgress.change')}
                      </span>
                    ) : null}
                  </span>
                  <span className="mk-meta block truncate">{detail}</span>
                </span>
                <Badge tone={STATUS_TONE[status]}>
                  {t(`marketplace.inProgress.status.${status}`)}
                </Badge>
                <span className="mk-ip-cta">
                  {t(`marketplace.inProgress.cta.${status}`)} <ArrowRightIcon size={11} />
                </span>
              </Link>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
