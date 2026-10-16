import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { GovErrorState, Skel } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import { Badge } from '../../components/Badge';
import {
  ArchiveIcon,
  ArrowRightIcon,
  ClockIcon,
  InboxIcon,
  LockIcon,
} from '../../components/icons';
import { SoonTag } from '../../components/Soon';
import { Topbar } from '../../components/Topbar';
import { useShell } from '../../layouts/ShellContext';
import { formatRelative } from '../../lib/format';
import { ApprovalDecision } from '../approvals/ApprovalDecision';
import type { Approval } from '../approvals/model';
import {
  SOON_TABS,
  TABS,
  bodyOf,
  isInboxView,
  keyOf,
  matchesView,
  runPath,
  titleOf,
  type InboxItem,
  type InboxPage as Page,
  type InboxTab,
  type InboxView,
} from './model';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | {
      kind: 'ready';
      view: InboxView;
      items: InboxItem[];
      cursor: string | null;
      /** Pages loaded beyond the first: a refresh then leaves the list as it is. */
      more: boolean;
      canDecide: boolean;
    };

/** New notices and approvals other people decide: the first page is read again this often. */
const POLL_MS = 60_000;
/** "hace 5 min" labels move on their own. */
const CLOCK_MS = 30_000;
const SKELETON_ROWS = [0, 1, 2, 3] as const;

function tabPath(tab: InboxView): string {
  return tab === 'all' ? '/inbox' : `/inbox/${tab}`;
}

function replaceItem(items: readonly InboxItem[], next: InboxItem): InboxItem[] {
  const key = keyOf(next);
  return items.map((item) => (keyOf(item) === key ? next : item));
}

function InboxRow({
  item,
  active,
  now,
  onOpen,
}: {
  item: InboxItem;
  active: boolean;
  now: number;
  onOpen: (item: InboxItem) => void;
}) {
  const { t } = useTranslation();
  const Icon = item.kind === 'approval' ? LockIcon : ClockIcon;
  const classes = ['inbox-row'];
  if (active) classes.push('on');
  if (!item.read) classes.push('is-unread');
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={classes.join(' ')}
      onClick={() => {
        onOpen(item);
      }}
    >
      <span
        className={item.read ? 'inbox-dot' : 'inbox-dot is-unread'}
        role={item.read ? undefined : 'img'}
        aria-label={item.read ? undefined : t('inbox.unreadDot')}
      />
      <span className={item.kind === 'approval' ? 'inbox-ic is-amber' : 'inbox-ic'}>
        <Icon size={15} />
      </span>
      <span className="inbox-row-main">
        <span className="inbox-row-t">{titleOf(t, item)}</span>
        <span className="inbox-row-s">
          {item.agent_name ? `${item.agent_name} · ` : ''}
          {bodyOf(t, item)}
        </span>
      </span>
      <span className="inbox-row-time">{formatRelative(item.at, now)}</span>
    </button>
  );
}

/**
 * Bandeja (design other-views.jsx `Inbox`, D83): the requests the person can sign and a notice for
 * each run of their tasks that ended. What each person sees, and every decision, is the API's:
 * the approvals come with the rule of the approvals screen and the notices from the person's own
 * partition. Everything is shown as plain text.
 */
export function InboxPage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const { inboxUnread, setInboxUnread } = useShell();
  const { notify, stack } = useToasts();
  const navigate = useNavigate();
  // `/inbox/<tab>`: untrusted input, only known tabs are used.
  const [routeTab = ''] = (useParams()['*'] ?? '').split('/');
  const view: InboxView = isInboxView(routeTab) ? routeTab : 'all';
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reloadToken, setReloadToken] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, CLOCK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = (first: boolean) => {
      api.call('listInbox', { query: { view } }, { signal: controller.signal }).then(
        (page: Page) => {
          if (controller.signal.aborted) return;
          setInboxUnread(page.unread);
          setState((current) =>
            !first && current.kind === 'ready' && current.view === view && current.more
              ? current
              : {
                  kind: 'ready',
                  view,
                  items: page.items,
                  cursor: page.next_cursor,
                  more: false,
                  canDecide: page.can_decide,
                },
          );
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          // A failed refresh keeps what is on screen; only the first load shows the error.
          if (first || (error instanceof ApiError && error.status === 403)) {
            setState({ kind: 'error' });
          }
        },
      );
    };
    load(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') load(false);
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [api, view, reloadToken, setInboxUnread]);

  const ready = state.kind === 'ready' && state.view === view ? state : null;
  const cursor = ready?.cursor ?? null;

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    api.call('listInbox', { query: { view, cursor } }).then(
      (page) => {
        setLoadingMore(false);
        setState((current) => {
          if (current.kind !== 'ready' || current.view !== view) return current;
          const seen = new Set(current.items.map(keyOf));
          return {
            ...current,
            items: [...current.items, ...page.items.filter((item) => !seen.has(keyOf(item)))],
            cursor: page.next_cursor,
            more: true,
          };
        });
      },
      () => {
        setLoadingMore(false);
      },
    );
  }, [api, cursor, loadingMore, view]);

  // Pages load as the end of the list comes into view (the design has no control for it).
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !cursor || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [cursor, loadMore]);

  const refreshUnread = useCallback(() => {
    api.call('unreadInbox').then(
      (result) => {
        setInboxUnread(result.unread);
      },
      () => undefined,
    );
  }, [api, setInboxUnread]);

  const update = useCallback((next: InboxItem) => {
    setState((current) =>
      current.kind === 'ready' ? { ...current, items: replaceItem(current.items, next) } : current,
    );
  }, []);

  const setItemState = useCallback(
    (item: InboxItem, change: { read?: boolean; archived?: boolean }) =>
      api
        .call('setInboxState', {
          path: { kind: item.kind, item_id: item.item_id },
          body: change,
        })
        .then(
          (next) => {
            update(next);
            refreshUnread();
            return next;
          },
          () => {
            notify(t('inbox.actionError'), 'error');
            return null;
          },
        ),
    [api, notify, refreshUnread, t, update],
  );

  const open = (item: InboxItem) => {
    setSelectedKey(keyOf(item));
    if (!item.read) {
      update({ ...item, read: true });
      void setItemState(item, { read: true });
    }
  };

  const archive = (item: InboxItem) => {
    void setItemState(item, { archived: !item.archived }).then((next) => {
      if (!next) return;
      notify(next.archived ? t('inbox.archived') : t('inbox.restored'), 'info');
      setSelectedKey((key) => (key === keyOf(item) ? null : key));
    });
  };

  const markAll = () => {
    api.call('readAllInbox', { body: {} }).then(
      (result) => {
        setInboxUnread(result.unread);
        setState((current) =>
          current.kind === 'ready'
            ? { ...current, items: current.items.map((item) => ({ ...item, read: true })) }
            : current,
        );
      },
      () => {
        notify(t('inbox.actionError'), 'error');
      },
    );
  };

  const onApprovalUpdated = useCallback(
    (approval: Approval) => {
      setState((current) => {
        if (current.kind !== 'ready') return current;
        return {
          ...current,
          items: current.items.map((item) =>
            item.approval?.approval_id === approval.approval_id ? { ...item, approval } : item,
          ),
        };
      });
      refreshUnread();
    },
    [refreshUnread],
  );

  const list = ready ? ready.items.filter((item) => matchesView(item, view)) : [];
  const current = ready?.items.find((item) => keyOf(item) === selectedKey) ?? null;
  const unread = inboxUnread ?? 0;

  const selectTab = (tab: InboxTab) => {
    if (!isInboxView(tab)) return;
    setSelectedKey(null);
    void navigate(tabPath(tab));
  };

  return (
    <>
      <Topbar
        crumbs={[t('inbox.title')]}
        actions={
          <button type="button" className="btn btn-sm" onClick={markAll} disabled={!unread}>
            {t('inbox.markAll')}
          </button>
        }
      />
      <div className="inbox">
        <div className="inbox-list">
          <div className="inbox-head">
            <h1 className="page-title">{t('inbox.title')}</h1>
            <p className="page-subtitle">
              {unread ? t('inbox.unread', { count: unread }) : t('inbox.allClear')}
            </p>
          </div>
          <div className="tabs" role="tablist" aria-label={t('inbox.tabsLabel')}>
            {TABS.map((tab) =>
              SOON_TABS.has(tab) ? (
                <span
                  key={tab}
                  role="tab"
                  aria-selected={false}
                  aria-disabled="true"
                  className="tab is-soon"
                  title={t('soon.title')}
                >
                  <span>{t(`inbox.tab.${tab}`)}</span>
                  <SoonTag />
                </span>
              ) : (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={tab === view}
                  className={tab === view ? 'tab active' : 'tab'}
                  onClick={() => {
                    selectTab(tab);
                  }}
                >
                  {t(`inbox.tab.${tab}`)}
                </button>
              ),
            )}
          </div>
          {state.kind === 'error' ? (
            <div className="inbox-empty" role="alert">
              <GovErrorState
                title={t('inbox.loadErrorTitle')}
                body={t('inbox.loadErrorBody')}
                onRetry={() => {
                  setState({ kind: 'loading' });
                  setReloadToken((value) => value + 1);
                }}
              />
            </div>
          ) : ready === null ? (
            <div role="status" aria-label={t('inbox.loading')}>
              {SKELETON_ROWS.map((row) => (
                <div key={row} className="inbox-row">
                  <span className="inbox-row-main">
                    <Skel w="60%" h={13} />
                    <Skel w="85%" h={11} />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div role="listbox" aria-label={t('inbox.listLabel')}>
              {list.length === 0 ? (
                <div className="inbox-empty">{t('inbox.empty')}</div>
              ) : (
                list.map((item) => (
                  <InboxRow
                    key={keyOf(item)}
                    item={item}
                    active={keyOf(item) === selectedKey}
                    now={now}
                    onOpen={open}
                  />
                ))
              )}
              {cursor ? <div ref={sentinel} className="inbox-more" aria-hidden="true" /> : null}
              {loadingMore ? (
                <div className="sr-only" role="status">
                  {t('inbox.loadingMore')}
                </div>
              ) : null}
            </div>
          )}
        </div>
        <div className="inbox-detail">
          {current ? (
            <div>
              <div className="inbox-detail-h">
                <Badge>{t(`inbox.type.${current.kind}`)}</Badge>
                <span className="inbox-detail-tools">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      void setItemState(current, { read: !current.read });
                    }}
                  >
                    {current.read ? t('inbox.markUnread') : t('inbox.markRead')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      archive(current);
                    }}
                  >
                    <ArchiveIcon size={12} />{' '}
                    {current.archived ? t('inbox.unarchive') : t('inbox.archive')}
                  </button>
                </span>
              </div>
              <h2 className="inbox-detail-t">{titleOf(t, current)}</h2>
              <div className="inbox-detail-m">
                {current.agent_name ?? t('inbox.system')} · {formatRelative(current.at, now)}
              </div>
              <p className="inbox-detail-b">{bodyOf(t, current)}</p>
              {current.approval ? (
                <div className="card inbox-card">
                  <ApprovalDecision
                    key={current.approval.approval_id}
                    api={api}
                    me={me}
                    approval={current.approval}
                    canDecide={ready?.canDecide ?? false}
                    now={now}
                    onUpdated={onApprovalUpdated}
                    notify={notify}
                  />
                </div>
              ) : null}
              <div className="inbox-actions">
                {current.approval ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      void navigate(`/approvals/pending/${current.item_id}`);
                    }}
                  >
                    {t('inbox.seeApprovals')} <ArrowRightIcon size={11} />
                  </button>
                ) : null}
                {current.run ? <RunLink item={current} /> : null}
              </div>
            </div>
          ) : (
            <div className="inbox-pick">
              <InboxIcon size={22} />
              <div>{t('inbox.selectOne')}</div>
            </div>
          )}
        </div>
      </div>
      {stack}
    </>
  );
}

function RunLink({ item }: { item: InboxItem }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const path = runPath(item);
  if (!path || !item.run) return null;
  return (
    <button
      type="button"
      className="btn btn-sm btn-primary"
      onClick={() => {
        void navigate(path);
      }}
    >
      {item.run.ok ? t('inbox.seeResult') : t('inbox.seeRun')} <ArrowRightIcon size={11} />
    </button>
  );
}
