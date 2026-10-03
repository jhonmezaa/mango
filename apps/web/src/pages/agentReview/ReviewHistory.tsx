import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../../api/client';
import type { Me } from '../../api/schemas';
import type { ToastTone } from '../../components/admin/useToasts';
import { Alert } from '../../components/Alert';
import { Badge } from '../../components/Badge';
import { SearchIcon } from '../../components/icons';
import { formatRelative } from '../../lib/format';
import {
  authorOf,
  decidedAt,
  EXPIRED_STEP,
  historyStatus,
  isKnownStatus,
  isStale,
  reasonOf,
  reviewErrorKey,
  reviewerOf,
  reviewKey,
  statusTone,
  type Review,
  type ReviewErrorKey,
} from './reviewModel';

interface Props {
  api: ApiClient;
  me: Me;
  list: readonly Review[];
  notify: (message: string, tone?: ToastTone) => void;
  onChanged: () => void;
}

/**
 * What happened to reviewed versions (design `ReviewHistory`). "Reintentar" publishes a failed
 * version again with the content that was approved; the API checks the hash and the permission.
 */
export function ReviewHistory({ api, me, list, notify, onChanged }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState<ReviewErrorKey | null>(null);

  // The caller's own decisions always carry a name: the email of the session.
  const reviewer = (review: Review) => {
    const decided = reviewerOf(review);
    return decided?.internal && decided.who === me.user_id && me.email
      ? { who: me.email, internal: false }
      : decided;
  };
  const needle = query.trim().toLowerCase();
  const rows = needle
    ? list.filter((review) =>
        `${review.name} ${authorOf(review)} ${reviewer(review)?.who ?? ''}`
          .toLowerCase()
          .includes(needle),
      )
    : list;

  const retry = (review: Review) => {
    const hash = review.content_hash;
    if (!hash) return;
    setRetrying(reviewKey(review));
    setError(null);
    api
      .call('retryVersion', {
        path: { agent_id: review.agent_id, version: review.version },
        body: { content_hash: hash },
      })
      .then(
        (version) => {
          if (version.status === 'failed') notify(t('agentReview.toast.retryFailed'), 'warn');
          else notify(t('agentReview.toast.retrying'), 'info');
          onChanged();
        },
        (cause: unknown) => {
          setError(reviewErrorKey(cause));
          if (isStale(cause)) onChanged();
        },
      )
      .finally(() => {
        setRetrying(null);
      });
  };

  return (
    <div className="mc-body">
      <div className="search-wrap rh-search">
        <SearchIcon size={13} />
        <input
          className="input"
          type="search"
          placeholder={t('agentReview.history.search')}
          aria-label={t('agentReview.history.searchLabel')}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>
      {error && (
        <Alert tone="red" role="alert" className="ap-error">
          {t(error)}
        </Alert>
      )}
      <div
        className="card mc-table rh-table"
        role="table"
        aria-label={t('agentReview.history.tableLabel')}
      >
        <div className="rh-tr mc-th" role="row">
          <span role="columnheader">{t('agentReview.history.agent')}</span>
          <span role="columnheader">{t('agentReview.history.change')}</span>
          <span role="columnheader">{t('agentReview.history.status')}</span>
          <span role="columnheader">{t('agentReview.history.by')}</span>
          <span role="columnheader">{t('agentReview.history.reviewer')}</span>
          <span role="columnheader">{t('agentReview.history.detail')}</span>
        </div>
        {rows.map((review) => {
          const key = reviewKey(review);
          const when = decidedAt(review);
          const status = historyStatus(review);
          const reason = reasonOf(review);
          const decided = reviewer(review);
          return (
            <div key={key} className="rh-tr" role="row">
              <span role="cell">
                <span className="mk-name">{review.name}</span>
                <span className="mk-meta mono">
                  {t('agentReview.versionId', { agent: review.agent_id, version: review.version })}
                  {when && ` · ${formatRelative(when)}`}
                </span>
              </span>
              <span role="cell" className="mk-meta">
                {review.kind === 'new'
                  ? t('agentReview.kind.new')
                  : review.changes === null
                    ? t('agentReview.kind.changeShort')
                    : t('agentReview.changes', { count: review.changes })}
              </span>
              <span role="cell">
                <Badge tone={statusTone(status)}>
                  {isKnownStatus(status) ? t(`agentReview.status.${status}`) : status}
                </Badge>
              </span>
              <span role="cell" className="rh-who" data-label={t('agentReview.history.byLabel')}>
                {authorOf(review)}
              </span>
              <span
                role="cell"
                className={decided?.internal ? 'rh-who mono' : 'rh-who'}
                data-label={t('agentReview.history.reviewerLabel')}
                title={decided?.internal ? t('agentReview.history.legacyReviewer') : undefined}
              >
                {decided?.who ?? t('agentReview.detail.none')}
              </span>
              <span role="cell" className="mk-meta">
                {status === 'failed' ? (
                  <>
                    {t('agentReview.history.failedAt', {
                      step:
                        review.status === 'failed'
                          ? (review.failed_step ?? EXPIRED_STEP)
                          : EXPIRED_STEP,
                    })}{' '}
                    {review.retryable && review.content_hash && (
                      <button
                        type="button"
                        className="sr-link"
                        disabled={retrying !== null}
                        aria-label={`${t('agentReview.history.retry')}: ${review.name}`}
                        onClick={() => {
                          retry(review);
                        }}
                      >
                        {t('agentReview.history.retry')}
                      </button>
                    )}
                  </>
                ) : reason ? (
                  // Reviewer text: rendered as text, between the design's quotes.
                  status === 'retired' ? (
                    t('agentReview.history.retired', { reason })
                  ) : (
                    `“${reason}”`
                  )
                ) : status === 'published' ? (
                  t('agentReview.history.published')
                ) : (
                  t('agentReview.detail.none')
                )}
              </span>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="mk-meta rh-none">{t('agentReview.history.noResults')}</div>
        )}
      </div>
    </div>
  );
}
