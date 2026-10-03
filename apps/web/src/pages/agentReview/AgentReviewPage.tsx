import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { useSession } from '../../auth/useSession';
import { Empty, GovErrorState, Skel } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import { Badge } from '../../components/Badge';
import {
  BotIcon,
  Check2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LockIcon,
} from '../../components/icons';
import { tabId } from '../../components/tabId';
import { Tabs } from '../../components/Tabs';
import { Topbar } from '../../components/Topbar';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { formatRelative } from '../../lib/format';
import { ReviewDetail } from './ReviewDetail';
import { ReviewHistory } from './ReviewHistory';
import {
  NO_REFERENCE,
  AGENT_ICONS,
  agentNameIndex,
  authorOf,
  groupTypeIndex,
  isForbidden,
  pastReviews,
  pendingReviews,
  reviewKey,
  toolIndex,
  type ReferenceData,
  type Review,
  type Reviews,
} from './reviewModel';

type Tab = 'review' | 'history';
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'forbidden' }
  | { kind: 'ready'; reviews: Reviews };

/** How often the lists are read again while an approved version is being published. */
const PUBLISHING_POLL_MS = 5000;
const PANEL_ID = 'review-panel';
/** Design: under this width the queue takes the whole page and the detail opens over it. */
const NARROW_QUERY = '(max-width: 760px)';
const SKELETON_ROWS = [0, 1, 2] as const;

function QueueRow({
  review,
  active,
  narrow,
  onSelect,
}: {
  review: Review;
  active: boolean;
  /** The row opens the detail over the queue: it says so with a chevron. */
  narrow: boolean;
  onSelect: (review: Review) => void;
}) {
  const { t } = useTranslation();
  const Icon = AGENT_ICONS[review.icon] ?? BotIcon;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={active ? 'card ap-row is-active' : 'card ap-row'}
      onClick={() => {
        onSelect(review);
      }}
    >
      <span className="mk-avatar sm is-neutral">
        <Icon size={14} />
      </span>
      <span className="ap-row-main">
        <span className="ap-row-t">{review.name}</span>
        <span className="ap-row-s">
          <span className="mono">
            {t('agentReview.versionId', { agent: review.agent_id, version: review.version })}
          </span>
          {' · '}
          {authorOf(review)}
          {review.submitted_at && ` · ${formatRelative(review.submitted_at)}`}
        </span>
        <span className="ap-row-badges">
          <Badge>
            {review.kind === 'new'
              ? t('agentReview.kind.new')
              : review.changes === null
                ? t('agentReview.kind.changeShort')
                : t('agentReview.changes', { count: review.changes })}
          </Badge>
          {review.status === 'approved' && <Badge tone="blue">{t('agentReview.publishing')}</Badge>}
          {review.is_author && <Badge>{t('agentReview.yours')}</Badge>}
        </span>
      </span>
      {narrow && <ChevronRightIcon size={14} className="ap-row-go" />}
    </button>
  );
}

function Forbidden({ crumbs }: { crumbs: string[] }) {
  const { t } = useTranslation();
  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="content">
        <div className="g-denied" role="status">
          <Empty icon={LockIcon} title={t('agentReview.denied.title')}>
            {t('agentReview.denied.body')}
          </Empty>
        </div>
      </div>
    </>
  );
}

/**
 * Revisión de agentes (design agent-review.jsx): the queue of versions waiting for another
 * administrator, each with its diff against the published version, and the history. The API
 * authorizes every call (`ApproveAgent`); `is_admin` only picks what to render.
 */
export function AgentReviewPage() {
  const { t } = useTranslation();
  const { me } = useSession();
  const crumbs = [t('agentReview.crumbGov'), t('agentReview.title')];
  // UX only: an account that is not an admin does not even ask. The API decides anyway.
  return me.is_admin ? <ReviewQueue crumbs={crumbs} /> : <Forbidden crumbs={crumbs} />;
}

function ReviewQueue({ crumbs }: { crumbs: string[] }) {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const { notify, stack } = useToasts();
  const navigate = useNavigate();
  // Deep link `/review/<agent>/<version>`: the version to open in the queue.
  const linked = useParams()['*'] ?? '';
  const narrow = useMediaQuery(NARROW_QUERY);
  const [tab, setTab] = useState<Tab>('review');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [refs, setRefs] = useState<ReferenceData>(NO_REFERENCE);

  const reload = useCallback(() => {
    api.call('getReviews').then(
      (reviews) => {
        setState({ kind: 'ready', reviews });
      },
      (error: unknown) => {
        if (isForbidden(error)) setState({ kind: 'forbidden' });
        // A failed refresh keeps what is on screen; only the first load shows the error.
        else setState((current) => (current.kind === 'ready' ? current : { kind: 'error' }));
      },
    );
  }, [api]);

  useEffect(reload, [reload]);

  // Names and labels for the detail, in parallel. They are optional: without them the detail
  // shows ids and no badges, and the decision still depends only on the API.
  useEffect(() => {
    let cancelled = false;
    const keep = <T,>(apply: (value: T) => Partial<ReferenceData>) => {
      return (value: T) => {
        if (!cancelled) setRefs((current) => ({ ...current, ...apply(value) }));
      };
    };
    const ignore = () => undefined;
    api.call('getCatalog').then(
      keep((catalog) => ({ tools: toolIndex(catalog) })),
      ignore,
    );
    api.call('listGroups').then(
      keep((groups) => ({ groupTypes: groupTypeIndex(groups) })),
      ignore,
    );
    api.call('getOrg').then(
      keep((org) => ({ agentNames: agentNameIndex(org) })),
      ignore,
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const reviews = state.kind === 'ready' ? state.reviews : null;
  const queue = reviews ? pendingReviews(reviews) : [];
  const publishing = queue.some((review) => review.status === 'approved');

  useEffect(() => {
    if (!publishing) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') reload();
    }, PUBLISHING_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [publishing, reload]);

  if (state.kind === 'forbidden') return <Forbidden crumbs={crumbs} />;

  // Design: the first version of the queue is open unless another one was chosen.
  const chosen = queue.find((review) => reviewKey(review) === linked) ?? null;
  const selected = chosen ?? queue[0] ?? null;
  // On a narrow screen the detail replaces the queue, and only for the version the URL names.
  const showDetail = narrow && tab === 'review' && chosen !== null;
  const select = (review: Review) => {
    // An internal route built from API data: the id is encoded, never trusted as a path.
    void navigate(`/review/${encodeURIComponent(review.agent_id)}/${review.version}`, {
      replace: true,
    });
  };

  // Listbox keyboard: the arrows move the selection, as the options are buttons in a list.
  const onQueueKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const index = selected ? queue.indexOf(selected) : -1;
    const next = queue[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    select(next);
    const options = event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]');
    options[queue.indexOf(next)]?.focus();
  };

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="content">
        {!showDetail && (
          <>
            <div className="page-head">
              <h1 className="page-title">{t('agentReview.title')}</h1>
              <p className="page-subtitle">{t('agentReview.subtitle')}</p>
            </div>
            <div className="ap-bar">
              <Tabs
                label={t('agentReview.tabsLabel')}
                idPrefix="review"
                panelId={PANEL_ID}
                active={tab}
                onChange={setTab}
                tabs={[
                  {
                    id: 'review',
                    label: t('agentReview.tabs.review'),
                    count: queue.length > 0 ? queue.length : null,
                  },
                  { id: 'history', label: t('agentReview.tabs.history') },
                ]}
              />
            </div>
          </>
        )}
        <div id={PANEL_ID} role="tabpanel" aria-labelledby={tabId('review', tab)}>
          {state.kind === 'loading' ? (
            <div className="ap-body" role="status" aria-label={t('agentReview.loading')}>
              <div className="ap-list">
                {SKELETON_ROWS.map((row) => (
                  <div key={row} className="card ap-row ap-row-skel">
                    <Skel w="55%" h={13} />
                    <Skel w="80%" h={11} />
                  </div>
                ))}
              </div>
            </div>
          ) : !reviews ? (
            <div className="ap-body" role="alert">
              <GovErrorState
                title={t('agentReview.loadErrorTitle')}
                body={t('agentReview.loadErrorBody')}
                onRetry={() => {
                  setState({ kind: 'loading' });
                  reload();
                }}
              />
            </div>
          ) : tab === 'history' ? (
            <ReviewHistory
              api={api}
              me={me}
              list={pastReviews(reviews)}
              notify={notify}
              onChanged={reload}
            />
          ) : !selected ? (
            <div className="mk-empty">
              <Check2Icon size={22} className="ap-empty-i" />
              <div className="ap-empty-t">{t('agentReview.empty.title')}</div>
              <div className="mk-meta">{t('agentReview.empty.body')}</div>
            </div>
          ) : (
            <div className={showDetail ? 'ap-body is-split show-detail' : 'ap-body is-split'}>
              <div
                className="ap-list"
                role="listbox"
                aria-label={t('agentReview.queueLabel')}
                onKeyDown={onQueueKey}
              >
                {queue.map((review) => (
                  <QueueRow
                    key={reviewKey(review)}
                    review={review}
                    active={review === selected}
                    narrow={narrow}
                    onSelect={select}
                  />
                ))}
              </div>
              {(!narrow || showDetail) && (
                <section className="ap-detail card" aria-label={t('agentReview.detail.label')}>
                  {narrow && (
                    <button
                      type="button"
                      className="ap-back"
                      onClick={() => {
                        void navigate('/review', { replace: true });
                      }}
                    >
                      <ChevronLeftIcon size={13} /> {t('agentReview.back')}
                    </button>
                  )}
                  <ReviewDetail
                    key={reviewKey(selected)}
                    api={api}
                    me={me}
                    review={selected}
                    refs={refs}
                    notify={notify}
                    onChanged={reload}
                  />
                </section>
              )}
            </div>
          )}
        </div>
      </div>
      {stack}
    </>
  );
}
