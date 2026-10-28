import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { GovErrorState, Skel } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import { Badge } from '../../components/Badge';
import {
  ArchiveIcon,
  BookOpenIcon,
  ArrowRightIcon,
  ChevronLeftIcon,
  ClockIcon,
  ExternalIcon,
  InboxIcon,
  LockIcon,
  RefreshIcon,
} from '../../components/icons';
import { SoonTag } from '../../components/Soon';
import { Topbar } from '../../components/Topbar';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useShell } from '../../layouts/ShellContext';
import { formatRelative } from '../../lib/format';
import { ApprovalDecision } from '../approvals/ApprovalDecision';
import type { Approval } from '../approvals/model';
import { SourceDecision, SourceFacts } from '../approvals/SourceCard';
import { knowledgePath } from '../approvals/sources';
import { useConnections } from '../connections/ConnectionsContext';
import { RemoteInboxDetail, RemoteInboxRow } from '../remoteMcp/inbox';
import { useRemoteInbox } from '../remoteMcp/inboxItems';
import { ReportDownload } from '../schedules/reports';
import {
  SOON_TABS,
  TABS,
  bodyOf,
  isInboxView,
  isPagedView,
  keyOf,
  matchesView,
  runPath,
  shownKind,
  RUN_ID,
  TASK_ID,
  remoteNoticeOf,
  titleOf,
  type InboxItem,
  type RemoteNotice,
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
const SKELETON_ROWS = [0, 1, 2, 3, 4] as const;
/** As Aprobaciones: at this width the detail replaces the list. */
const NARROW_QUERY = '(max-width: 900px)';

function tabPath(tab: InboxView): string {
  return tab === 'all' ? '/inbox' : `/inbox/${tab}`;
}

/** DOM id of a row: focus goes back to it when the narrow detail closes. Ids are API-checked. */
function rowId(item: Pick<InboxItem, 'kind' | 'item_id'>): string {
  return `inbox-row-${item.kind}-${item.item_id}`;
}

function replaceItem(items: readonly InboxItem[], next: InboxItem): InboxItem[] {
  const key = keyOf(next);
  return items.map((item) => (keyOf(item) === key ? next : item));
}

/** What a `remote_connect` notice is about, once the person's connections are read. */
function useRemoteNotice(item: InboxItem | null): RemoteNotice {
  const { byRegistration, ensure, status } = useConnections();
  const remote = item?.kind === 'remote_connect';
  useEffect(() => {
    if (remote) ensure();
  }, [remote, ensure]);
  if (!item) return null;
  return remoteNoticeOf(item, (id) => byRegistration(id)?.service ?? null, status === 'ready');
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
  const service = useRemoteNotice(item);
  // Design `ICON`: a proposal of a knowledge base, an approval, a run or a remote to connect.
  const Icon = service
    ? ExternalIcon
    : item.kind === 'kbsource'
      ? BookOpenIcon
      : item.kind === 'approval'
        ? LockIcon
        : ClockIcon;
  const mono = shownKind(item) !== 'run';
  const classes = ['inbox-row'];
  if (active) classes.push('on');
  if (!item.read) classes.push('is-unread');
  return (
    <button
      type="button"
      id={rowId(item)}
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
      <span className={shownKind(item) === 'run' && !service ? 'inbox-ic' : 'inbox-ic is-amber'}>
        <Icon size={15} />
      </span>
      <span className="inbox-row-main">
        <span className="inbox-row-t">{titleOf(t, item, service)}</span>
        <span className="inbox-row-s">
          {item.agent_name && !service ? `${item.agent_name} · ` : ''}
          {mono ? (
            <span className="mono inbox-row-mono">{bodyOf(t, item)}</span>
          ) : (
            bodyOf(t, item, service)
          )}
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
  const [more, setMore] = useState<'loading' | 'error' | null>(null);
  const narrow = useMediaQuery(NARROW_QUERY);
  const detailTitle = useRef<HTMLHeadingElement | null>(null);
  const remoteItems = useRemoteInbox(api, me.is_admin);

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

  const loadMore = () => {
    if (!cursor || more === 'loading') return;
    setMore('loading');
    api.call('listInbox', { query: { view, cursor } }).then(
      (page) => {
        setMore(null);
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
        setMore('error');
      },
    );
  };

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
      // As the design: a notice that could not be marked as read stays unread, without an error,
      // and is marked the next time it is opened.
      void api
        .call('setInboxState', {
          path: { kind: item.kind, item_id: item.item_id },
          body: { read: true },
        })
        .then(
          (next) => {
            update(next);
            refreshUnread();
          },
          () => {
            update(item);
          },
        );
    }
  };

  // Narrow screen (design, ≤900 px): the detail replaces the list, «Volver a la lista» and Esc go
  // back, focus goes to the notice's title and, on the way back, to its row.
  const back = useCallback(() => {
    const key = selectedKey;
    setSelectedKey(null);
    if (!key) return;
    const [kind = '', itemId = ''] = key.split(':');
    window.setTimeout(() => {
      document.getElementById(`inbox-row-${kind}-${itemId}`)?.focus();
    }, 0);
  }, [selectedKey]);

  const showDetail = narrow && selectedKey !== null;
  useEffect(() => {
    if (!showDetail) return undefined;
    detailTitle.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') back();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [showDetail, back]);

  const archive = (item: InboxItem) => {
    void setItemState(item, { archived: !item.archived }).then((next) => {
      if (!next) return;
      notify(next.archived ? t('inbox.archived') : t('inbox.restored'), 'info');
      if (selectedKey === keyOf(item)) back();
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
  const currentService = useRemoteNotice(current);
  const { openMine } = useConnections();
  // Requests of remote services for administrators, on top (design `RM.inboxItems`). They have
  // no read or archived state on the server, so only «Todo» and «Aprobaciones» list them.
  const remoteShown = view === 'all' || view === 'approvals' ? remoteItems : [];
  const currentRemote = remoteShown.find((item) => item.key === selectedKey) ?? null;
  const unread = inboxUnread ?? 0;

  const selectTab = (tab: InboxTab | 'archived') => {
    if (!isInboxView(tab)) return;
    setSelectedKey(null);
    setMore(null);
    void navigate(tabPath(tab));
  };
  const archivedView = view === 'archived';

  return (
    <>
      <Topbar
        crumbs={[t('inbox.title')]}
        actions={
          <button
            type="button"
            className="btn btn-sm"
            onClick={markAll}
            disabled={!unread || ready === null}
          >
            {t('inbox.markAll')}
          </button>
        }
      />
      <div className={current ? 'inbox show-detail' : 'inbox'}>
        <div className="inbox-list">
          <div className="inbox-head">
            <h1 className="page-title">{t('inbox.title')}</h1>
            <div className="inbox-sub">
              <p className="page-subtitle">
                {archivedView
                  ? t('inbox.archivedTitle')
                  : unread
                    ? t('inbox.unread', { count: unread })
                    : t('inbox.allClear')}
              </p>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  selectTab(archivedView ? 'all' : 'archived');
                }}
              >
                {archivedView ? (
                  <>
                    <ChevronLeftIcon size={12} /> {t('inbox.backToInbox')}
                  </>
                ) : (
                  <>
                    <ArchiveIcon size={12} /> {t('inbox.archivedButton')}
                  </>
                )}
              </button>
            </div>
          </div>
          {archivedView ? null : (
            <div className="tabs" role="tablist" aria-label={t('inbox.tabsLabel')}>
              {TABS.map((tab) =>
                SOON_TABS.has(tab) ? (
                  <span
                    key={tab}
                    role="tab"
                    aria-selected={false}
                    aria-disabled="true"
                    className="tab is-soon"
                    title={t('soon.tag')}
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
          )}
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
                <div key={row} className="inbox-row is-skel">
                  <span className="inbox-dot" />
                  <span className="inbox-row-main inbox-skel">
                    <Skel w="64%" />
                    <Skel w="88%" h={10} />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div role="listbox" aria-label={t('inbox.listLabel')}>
              {remoteShown.map((item) => (
                <RemoteInboxRow
                  key={item.key}
                  item={item}
                  active={item.key === selectedKey}
                  now={now}
                  onOpen={setSelectedKey}
                />
              ))}
              {list.length === 0 && remoteShown.length === 0 ? (
                <div className="inbox-empty">
                  {cursor && isPagedView(view) ? t('inbox.emptyWithMore') : t('inbox.empty')}
                </div>
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
              {cursor && isPagedView(view) ? (
                <div className="inbox-more">
                  {more === 'error' ? (
                    <div role="alert" className="inbox-more-err">
                      <span>{t('inbox.moreError')}</span>
                      <button type="button" className="btn btn-sm" onClick={loadMore}>
                        <RefreshIcon size={12} /> {t('inbox.retry')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={more === 'loading'}
                      onClick={loadMore}
                    >
                      {more === 'loading' ? (
                        <>
                          <span className="g-spin" aria-hidden="true" /> {t('inbox.loadingMore')}
                        </>
                      ) : (
                        t('inbox.showMore')
                      )}
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>
        <div className="inbox-detail">
          {current ? (
            <div>
              <button type="button" className="btn btn-sm btn-ghost inbox-back" onClick={back}>
                <ChevronLeftIcon size={12} /> {t('inbox.backToList')}
              </button>
              <div className="inbox-detail-h">
                <Badge>
                  {currentService
                    ? t('connections.inbox.type')
                    : t(`inbox.type.${shownKind(current)}`)}
                </Badge>
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
              <h2 className="inbox-detail-t" ref={detailTitle} tabIndex={-1}>
                {titleOf(t, current, currentService)}
              </h2>
              <div className="inbox-detail-m">
                {currentService
                  ? t('connections.inbox.source')
                  : current.source
                    ? t('inbox.knowledgeBases')
                    : (current.agent_name ?? t('inbox.system'))}{' '}
                · {formatRelative(current.at, now)}
              </div>
              <p
                className={
                  shownKind(current) === 'run' ? 'inbox-detail-b' : 'inbox-detail-b mono is-mono'
                }
              >
                {bodyOf(t, current, currentService)}
              </p>
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
              {current.source ? (
                <div className="card inbox-card grid gap-3.5">
                  <SourceFacts source={current.source} compact />
                  <SourceDecision
                    key={current.item_id}
                    api={api}
                    me={me}
                    source={current.source}
                    notify={notify}
                    onChanged={() => {
                      setReloadToken((value) => value + 1);
                      refreshUnread();
                    }}
                  />
                </div>
              ) : null}
              <div className="inbox-actions">
                {current.approval || current.source ? (
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
                {current.source ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      if (current.source) void navigate(knowledgePath(current.source));
                    }}
                  >
                    {t('inbox.openKb')} <ArrowRightIcon size={11} />
                  </button>
                ) : null}
                {currentService?.kind === 'connect' ? (
                  <button type="button" className="btn btn-sm btn-primary" onClick={openMine}>
                    {t('connections.inbox.action')} <ArrowRightIcon size={11} />
                  </button>
                ) : null}
                {currentService?.kind === 'gone' ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => {
                      void navigate('/schedules');
                    }}
                  >
                    {t('inbox.remoteGone.action')} <ArrowRightIcon size={11} />
                  </button>
                ) : null}
                {current.run && !currentService ? <RunLink item={current} /> : null}
                {current.run?.ok ? <RunPdf key={current.item_id} api={api} item={current} /> : null}
              </div>
            </div>
          ) : currentRemote ? (
            <RemoteInboxDetail
              item={currentRemote}
              now={now}
              titleRef={detailTitle}
              onBack={back}
            />
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

/**
 * Design (Bandeja, part D of 2026-10-16b): with the PDF of the run ready, its notice also
 * offers «Descargar PDF» (D86). The notice does not carry it: the run says, for its owner.
 */
function RunPdf({ api, item }: { api: ApiClient; item: InboxItem }) {
  const [ready, setReady] = useState(false);
  const taskId = item.run?.task_id ?? '';
  const runId = item.run?.run_id ?? '';
  useEffect(() => {
    if (!TASK_ID.test(taskId) || !RUN_ID.test(runId)) return;
    const controller = new AbortController();
    api
      .call(
        'getTaskRun',
        { path: { task_id: taskId, run_id: runId } },
        { signal: controller.signal },
      )
      .then(
        (found) => {
          if (!controller.signal.aborted) setReady(found.report?.status === 'ready');
        },
        () => undefined,
      );
    return () => {
      controller.abort();
    };
  }, [api, taskId, runId]);
  if (!ready) return null;
  return <ReportDownload api={api.call} taskId={taskId} runId={runId} button />;
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
