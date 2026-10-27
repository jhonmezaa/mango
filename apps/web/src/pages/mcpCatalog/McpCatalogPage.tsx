import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { adminErrorKey, apiErrorCode, isStaleDataError } from '../../api/adminErrors';
import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { Denied, GovErrorState, Skel } from '../../components/admin/govKit';
import { SoonTag } from '../../components/Soon';
import { useToasts } from '../../components/admin/useToasts';
import { ArrowRightIcon, Check2Icon, PlusIcon, SearchIcon } from '../../components/icons';
import { tabId } from '../../components/tabId';
import { Tabs } from '../../components/Tabs';
import { Topbar } from '../../components/Topbar';
import { formatRelative } from '../../lib/format';
import { McpDetail, type PackAction } from './McpDetail';
import { RemoteCatalogTab, RemoteRequests } from '../remoteMcp/catalog';
import { parseRemotePath, pendingRows, remotePath, type Row } from '../remoteMcp/model';
import { RemoteDetail } from '../remoteMcp/RemoteDetail';
import { useRemoteActions, useRemoteCatalog } from '../remoteMcp/useRemoteCatalog';
import {
  LEVELS,
  NO_FILTERS,
  QUERY_MAX_LENGTH,
  STATUS_ORDER,
  filterServers,
  filterTools,
  hasFilters,
  isLevel,
  isWorking,
  isWriteTool,
  paramChanges,
  pendingRequests,
  requesterOf,
  shownVersion,
  statusOf,
  toolRows,
  destructiveTools,
  isDestructive,
  writeTools,
  type Catalog,
  type Filters,
  type KindFilter,
  type PendingRequest,
  type Server,
  type ServerStatus,
  type ToolFilters,
  type ToolKind,
  type ToolRow,
} from './model';
import {
  AccessBadge,
  KindLabel,
  LevelBadge,
  ModeBadge,
  ServerIcon,
  StatusBadge,
  ToolChip,
} from './parts';

type LoadState = { kind: 'loading' } | { kind: 'ready'; data: Catalog } | { kind: 'error' };
type Tab = 'catalog' | 'tools' | 'remote' | 'requests';

const PANEL_ID = 'mcp-panel';
const KINDS: readonly KindFilter[] = ['all', 'connector', 'pack'];
const TOOL_KINDS: readonly ToolKind[] = ['all', 'read', 'write'];
/** Design: the «Destructivas» filter only when some tool is. */
const TOOL_KINDS_DESTRUCTIVE: readonly ToolKind[] = [...TOOL_KINDS, 'destructive'];
const NO_TOOL_FILTERS: ToolFilters = { query: '', kind: 'all', onlyEnabled: false };
/** While the provisioner installs or removes a pack, the catalog is read again this often. */
const POLL_MS = 5000;
const OWN_ERRORS = new Set([
  'use_withdraw',
  'invalid_state',
  'busy',
  'pending_exists',
  'pack_unsupported',
  'too_many_packs',
  'update_required',
  'up_to_date',
  'release_changed',
  'invalid_config',
  'no_change',
  'reason_required',
  'identity_mode_changed',
  'not_requester',
  'provisioner_unavailable',
  'catalog_unavailable',
] as const);
type OwnError = typeof OWN_ERRORS extends Set<infer Code> ? Code : never;

function isOwnError(code: string | null): code is OwnError {
  return code !== null && (OWN_ERRORS as Set<string>).has(code);
}

function isStatus(value: string): value is ServerStatus {
  return (STATUS_ORDER as readonly string[]).includes(value);
}

function ServerRow({ server, onOpen }: { server: Server; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const write = writeTools(server);
  const destructive = destructiveTools(server);
  return (
    <button
      type="button"
      className="mc-tr"
      onClick={() => {
        onOpen(server.id);
      }}
    >
      <span className="flex min-w-0 items-center gap-3">
        <ServerIcon server={server} />
        <span className="min-w-0">
          <span className="mk-name block">{server.name}</span>
          <span className="mk-meta block truncate">
            <KindLabel server={server} /> · <span className="mono">{server.id}</span>
          </span>
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <StatusBadge status={statusOf(server)} />
        {server.pack?.pending?.kind === 'update' ? (
          <span className="badge badge-amber" title={t('mcpCatalog.updateBadgeTitle')}>
            {t('mcpCatalog.updateBadge')}
          </span>
        ) : null}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <LevelBadge server={server} />
        <ModeBadge server={server} />
      </span>
      <span className="mk-meta">
        {write > 0 ? (
          <>
            {server.tools.length} ·{' '}
            <span className="text-warn">{t('mcpCatalog.toolsWrite', { count: write })}</span>
          </>
        ) : destructive > 0 ? (
          server.tools.length
        ) : (
          t('mcpCatalog.toolsRead', { count: server.tools.length })
        )}
        {destructive > 0 ? (
          <>
            {' · '}
            <span className="text-danger">
              {t('mcpCatalog.toolsDestructive', { count: destructive })}
            </span>
          </>
        ) : null}
      </span>
      <span className="mk-meta">{server.agents.length || '—'}</span>
      <span>
        <SoonTag />
      </span>
    </button>
  );
}

/** Design `McpToolsTable`: every tool of the catalog, with its own search and filters. */
function ToolsTable({ rows, onOpen }: { rows: readonly ToolRow[]; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<ToolFilters>(NO_TOOL_FILTERS);
  const list = filterTools(rows, filters);
  const writeEnabled = rows.filter(
    ({ tool }) => tool.access !== 'read' && !isDestructive(tool) && tool.enabled,
  ).length;
  const kinds = rows.some(({ tool }) => isDestructive(tool)) ? TOOL_KINDS_DESTRUCTIVE : TOOL_KINDS;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="search-wrap max-w-[300px] flex-[1_1_220px]">
          <SearchIcon size={13} />
          <input
            className="input"
            placeholder={t('mcpCatalog.toolsTab.search')}
            aria-label={t('mcpCatalog.toolsTab.searchLabel')}
            maxLength={QUERY_MAX_LENGTH}
            value={filters.query}
            onChange={(event) => {
              setFilters((current) => ({ ...current, query: event.target.value }));
            }}
          />
        </div>
        <div className="tk-quick" role="group" aria-label={t('mcpCatalog.toolsTab.kindLabel')}>
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className={filters.kind === kind ? 'is-on' : undefined}
              aria-pressed={filters.kind === kind}
              onClick={() => {
                setFilters((current) => ({ ...current, kind }));
              }}
            >
              {t(`mcpCatalog.toolsTab.${kind}`)}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
          <input
            type="checkbox"
            className="mc-check"
            checked={filters.onlyEnabled}
            onChange={(event) => {
              setFilters((current) => ({ ...current, onlyEnabled: event.target.checked }));
            }}
          />
          {t('mcpCatalog.toolsTab.onlyEnabled')}
        </label>
        <div className="flex-1" />
        <span className="mk-meta">
          {t('mcpCatalog.toolsTab.writeEnabled', { count: writeEnabled })}
        </span>
      </div>
      <div className="card mc-table">
        <div className="mt-tr mc-th" aria-hidden="true">
          <span>{t('mcpCatalog.toolsTab.table.tool')}</span>
          <span>{t('mcpCatalog.toolsTab.table.mcp')}</span>
          <span>{t('mcpCatalog.toolsTab.table.kind')}</span>
          <span>{t('mcpCatalog.toolsTab.table.level')}</span>
          <span>{t('mcpCatalog.toolsTab.table.status')}</span>
        </div>
        {list.map(({ server, tool }) => (
          <button
            key={tool.ref}
            type="button"
            className="mt-tr"
            onClick={() => {
              onOpen(server.id);
            }}
          >
            <span className="min-w-0">
              <span className="mono block text-[12.5px] font-semibold">{tool.name}</span>
              {tool.description ? (
                <span className="mk-meta block truncate">{tool.description}</span>
              ) : null}
            </span>
            <span className="truncate text-[13px]">{server.name}</span>
            <span>
              <AccessBadge tool={tool} />
            </span>
            <span className="flex flex-wrap items-center gap-1">
              <LevelBadge server={server} />
              <ModeBadge server={server} />
            </span>
            <span>
              <StatusBadge status={statusOf(server)} />
            </span>
          </button>
        ))}
        {list.length === 0 ? (
          <div className="mk-meta p-4" role="status">
            {t('mcpCatalog.toolsTab.empty')}
          </div>
        ) : null}
      </div>
    </>
  );
}

function RequestCard({ item, onOpen }: { item: PendingRequest; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const { server, pack, request } = item;
  const update = request.kind === 'update' ? pack.update : null;
  const detail =
    request.kind === 'params'
      ? paramChanges(pack, request.config)
          .map((change) => t('mcpCatalog.requests.change', { ...change }))
          .join('')
      : request.kind === 'enable'
        ? Object.entries(request.config)
            .map(([key, value]) => t('mcpCatalog.requests.value', { key, value }))
            .join('')
        : '';
  return (
    <div className="card mc-req">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mk-name">{server.name}</span>
          <span className="badge">
            {request.kind === 'update'
              ? t('mcpCatalog.requests.kind.update', {
                  from: shownVersion(pack),
                  to: request.pack_version,
                })
              : t(`mcpCatalog.requests.kind.${request.kind}`)}
          </span>
          <LevelBadge server={server} />
          <ModeBadge server={server} />
        </div>
        <div className="mk-meta mt-[3px]">
          {t('mcpCatalog.requests.by', {
            by: requesterOf(request),
            when: formatRelative(request.created_at),
          })}
          {detail}
        </div>
        {request.kind === 'enable' && request.reason ? (
          <div className="mt-1.5 text-[13px]">“{request.reason}”</div>
        ) : null}
        {update ? (
          <div className="mt-1.5 text-[13px]">
            {update.added_tools.length > 0 ? (
              <>
                {t('mcpCatalog.requests.adds')}{' '}
                {update.added_tools.map((name) => (
                  <ToolChip key={name} name={name} tone="add" write={isWriteTool(server, name)} />
                ))}
              </>
            ) : null}
            {update.removed_tools.length > 0 ? (
              <>
                {' '}
                {t('mcpCatalog.requests.removes')}{' '}
                {update.removed_tools.map((name) => (
                  <ToolChip key={name} name={name} tone="rem" />
                ))}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          onOpen(server.id);
        }}
      >
        {t('mcpCatalog.requests.review')} <ArrowRightIcon size={11} />
      </button>
    </div>
  );
}

/** Design `McpRequests`: what waits for this administrator first, then what they asked for. */
function Requests({
  requests,
  onOpen,
}: {
  requests: readonly PendingRequest[];
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (requests.length === 0) {
    return (
      <div className="mk-empty" role="status">
        <Check2Icon size={22} className="text-ok" />
        <div className="text-sm font-semibold">{t('mcpCatalog.requests.emptyTitle')}</div>
        <div className="mk-meta">{t('mcpCatalog.requests.emptyBody')}</div>
      </div>
    );
  }
  const groups = [
    { id: 'theirs', items: requests.filter((item) => !item.request.own) },
    { id: 'mine', items: requests.filter((item) => item.request.own) },
  ] as const;
  return (
    <div className="grid gap-2.5">
      {groups.map((group) =>
        group.items.length > 0 ? (
          <section key={group.id} className="mc-req-group grid gap-2.5">
            <h2 className="mk-sec-t">
              {t(`mcpCatalog.requests.${group.id}`, { count: group.items.length })}
            </h2>
            {group.items.map((item) => (
              <RequestCard key={item.request.change_id} item={item} onOpen={onOpen} />
            ))}
          </section>
        ) : null,
      )}
    </div>
  );
}

/**
 * Catálogo de MCP (design mcp-catalog.jsx): the connectors of Mango and the MCP packs of the
 * release. An administrator asks for a pack and a different one approves it; the API authorizes
 * and audits every action (`EnableMcp`, `ApproveMcp`), the checks here are only UX. Creators read
 * the catalog without requests or history. Health and connecting an MCP by URL are
 * "Próximamente".
 */
export function McpCatalogPage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const { notify, stack } = useToasts();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [forbidden, setForbidden] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [tab, setTab] = useState<Tab>('catalog');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  // Servicios externos (D93, D98): `/mcp/remote/<profile>/<row>` opens a card or a row of it, so
  // Ajustes › Conectividad and the Bandeja can link here. The path is untrusted input.
  const navigate = useNavigate();
  const rest = useParams()['*'] ?? '';
  const target = parseRemotePath(rest);
  const remote = useRemoteCatalog(api);
  const actRemote = useRemoteActions(api, remote.replace, notify);
  const [groups, setGroups] = useState<string[] | null>(null);
  const [lastRest, setLastRest] = useState<string | null>(null);
  if (rest !== lastRest) {
    // A new path (a link from elsewhere) picks the tab; the drawer follows the path below.
    setLastRest(rest);
    if (target) setTab('remote');
  }
  const remoteProfile = target?.profile ?? null;
  const needGroups = me.is_admin && remoteProfile !== null && groups === null;
  useEffect(() => {
    if (!needGroups) return;
    const controller = new AbortController();
    api.call('listGroups', {}, { signal: controller.signal }).then(
      (data) => {
        setGroups(data.items.map((group) => group.id));
      },
      () => undefined,
    );
    return () => {
      controller.abort();
    };
  }, [api, needGroups]);
  const openRemote = (profileId?: string, row?: Row) => {
    void navigate(remotePath(profileId, row));
  };

  useEffect(() => {
    const controller = new AbortController();
    api.call('getCatalog', {}, { signal: controller.signal }).then(
      (data) => {
        setState({ kind: 'ready', data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 403) setForbidden(true);
        setState({ kind: 'error' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, reloadToken]);

  const working =
    state.kind === 'ready' && state.data.items.some((server) => isWorking(statusOf(server)));

  // The provisioner changes the status on its own: keep reading until nothing is in progress.
  useEffect(() => {
    if (!working) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      api.call('getCatalog', {}, { signal: controller.signal }).then(
        (data) => {
          if (!controller.signal.aborted) setState({ kind: 'ready', data });
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [api, working]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setReloadToken((value) => value + 1);
  }, []);

  /** Sends one action with the pack's lock version; a stale catalog is reloaded. */
  const act = async (server: Server, action: PackAction): Promise<string | null> => {
    const pack = server.pack;
    if (!pack) return t('admin.errors.generic');
    const path = { pack: server.id };
    const version = pack.lock_version;
    try {
      let data: Catalog;
      let toast: string;
      let tone: 'success' | 'info' = 'success';
      if (action.kind === 'request') {
        data = await api.call('requestPackEnablement', {
          path,
          body: { version, config: action.config, reason: action.reason || null },
        });
        toast = t('mcpCatalog.toast.requested');
      } else if (action.kind === 'params') {
        data = await api.call('requestPackParams', {
          path,
          body: { version, config: action.config },
        });
        toast = t('mcpCatalog.toast.paramsRequested');
      } else if (action.kind === 'approve') {
        data = await api.call('approvePackRequest', {
          path: { ...path, change_id: action.request.change_id },
          body: {},
        });
        toast =
          action.request.kind === 'params'
            ? t('mcpCatalog.toast.paramsApproved')
            : action.request.kind === 'update'
              ? t('mcpCatalog.toast.updateApproved')
              : t('mcpCatalog.toast.approved', { name: server.name });
      } else if (action.kind === 'reject') {
        data = await api.call('rejectPackRequest', {
          path: { ...path, change_id: action.request.change_id },
          body: { reason: action.reason || null },
        });
        toast =
          action.request.kind === 'params'
            ? t('mcpCatalog.toast.paramsRejected')
            : action.request.kind === 'update'
              ? t('mcpCatalog.toast.updateRejected')
              : t('mcpCatalog.toast.rejected');
        tone = 'info';
      } else if (action.kind === 'withdraw') {
        data = await api.call('withdrawPackRequest', {
          path: { ...path, change_id: action.request.change_id },
          body: {},
        });
        toast = t('mcpCatalog.toast.withdrawn');
        tone = 'info';
      } else if (action.kind === 'update') {
        data = await api.call('requestPackUpdate', { path, body: { version } });
        toast = t('mcpCatalog.toast.updateRequested');
      } else if (action.kind === 'retry') {
        data = await api.call('retryPack', { path, body: { version } });
        toast = t('mcpCatalog.toast.retried');
      } else {
        data = await api.call('disablePack', { path, body: { version, reason: action.reason } });
        toast = t('mcpCatalog.toast.disabled', { name: server.name });
        tone = 'info';
      }
      setState({ kind: 'ready', data });
      notify(toast, tone);
      return null;
    } catch (error) {
      const code = apiErrorCode(error);
      // The approval is recorded even when the provisioner did not start: show what happened.
      if (isStaleDataError(error) || code === 'provisioner_unavailable') {
        try {
          setState({ kind: 'ready', data: await api.call('getCatalog') });
        } catch (reloadError) {
          return t(adminErrorKey(reloadError));
        }
      }
      return isOwnError(code) ? t(`mcpCatalog.errors.${code}`) : t(adminErrorKey(error));
    }
  };

  const crumbs = [t('mcpCatalog.crumbBuild'), t('mcpCatalog.title')];
  const remoteData = remote.state.kind === 'ready' ? remote.state.data : null;
  const remotePending = remoteData ? pendingRows(remoteData).length : 0;
  const remoteDetail =
    remoteData && remoteProfile
      ? (remoteData.profiles.find((profile) => profile.id === remoteProfile) ?? null)
      : null;
  if (forbidden) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <Denied />
        </div>
      </>
    );
  }

  const data = state.kind === 'ready' ? state.data : null;
  const servers = data?.items ?? [];
  const list = filterServers(servers, filters);
  const tools = toolRows(servers);
  const requests = pendingRequests(servers);
  const detail = selected === null ? null : servers.find((server) => server.id === selected);
  const statusCount = (status: ServerStatus) =>
    servers.filter((server) => statusOf(server) === status).length;
  const patch = (changes: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...changes }));
  };

  return (
    <>
      <Topbar
        crumbs={crumbs}
        actions={
          // Design: with remote services, the action adds one of them (D93); connecting an MCP
          // by URL stays out.
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              openRemote();
            }}
          >
            <PlusIcon size={12} />
            <span className="mc-connect-label">{t('remoteMcp.add')}</span>
          </button>
        }
      />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('mcpCatalog.title')}</h1>
          <p className="page-subtitle">{t('remoteMcp.subtitle')}</p>
        </div>
        {state.kind === 'error' ? (
          <div className="mc-body">
            <GovErrorState
              title={t('mcpCatalog.loadError')}
              body={t('admin.errors.unavailable')}
              onRetry={retry}
            />
          </div>
        ) : data === null ? (
          <div className="mc-body" role="status" aria-label={t('mcpCatalog.loading')}>
            <Skel h={40} className="mb-4 rounded-xl" />
            <Skel h={260} className="rounded-xl" />
          </div>
        ) : (
          <>
            <div className="ap-bar">
              <Tabs
                label={t('mcpCatalog.tabsLabel')}
                idPrefix="mcp"
                panelId={PANEL_ID}
                active={tab}
                onChange={(next) => {
                  setTab(next);
                  // Leaving the tab closes a card the path had opened.
                  if (target && next !== 'remote') void navigate('/mcp');
                }}
                tabs={[
                  { id: 'catalog', label: t('mcpCatalog.tabs.catalog'), count: servers.length },
                  { id: 'tools', label: t('mcpCatalog.tabs.tools'), count: tools.length },
                  {
                    id: 'remote',
                    label: t('remoteMcp.tab'),
                    count: remoteData ? remoteData.profiles.length : null,
                  },
                  {
                    id: 'requests',
                    label: t('mcpCatalog.tabs.requests'),
                    count:
                      requests.length + remotePending > 0 ? requests.length + remotePending : null,
                  },
                ]}
              />
              {tab === 'catalog' ? (
                <div className="ap-filters">
                  <div className="search-wrap max-w-[300px] flex-[1_1_220px]">
                    <SearchIcon size={13} />
                    <input
                      className="input"
                      placeholder={t('mcpCatalog.search')}
                      aria-label={t('mcpCatalog.searchLabel')}
                      maxLength={QUERY_MAX_LENGTH}
                      value={filters.query}
                      onChange={(event) => {
                        patch({ query: event.target.value });
                      }}
                    />
                  </div>
                  <div className="tk-quick" role="group" aria-label={t('mcpCatalog.kindLabel')}>
                    {KINDS.map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        className={filters.kind === kind ? 'is-on' : undefined}
                        aria-pressed={filters.kind === kind}
                        onClick={() => {
                          patch({ kind });
                        }}
                      >
                        {t(`mcpCatalog.kinds.${kind}`)}
                      </button>
                    ))}
                  </div>
                  <select
                    className="input mk-sel"
                    aria-label={t('mcpCatalog.statusLabel')}
                    value={filters.status}
                    onChange={(event) => {
                      const { value } = event.target;
                      patch({ status: isStatus(value) ? value : 'all' });
                    }}
                  >
                    <option value="all">{t('mcpCatalog.anyStatus')}</option>
                    {STATUS_ORDER.map((status) => (
                      <option key={status} value={status}>
                        {t('mcpCatalog.statusOption', {
                          label: t(`mcpCatalog.status.${status}`),
                          count: statusCount(status),
                        })}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input mk-sel"
                    aria-label={t('mcpCatalog.levelLabel')}
                    value={filters.level}
                    onChange={(event) => {
                      const { value } = event.target;
                      patch({ level: isLevel(value) ? value : 'all' });
                    }}
                  >
                    <option value="all">{t('mcpCatalog.anyLevel')}</option>
                    {LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {t(`mcpCatalog.levels.${level}`)}
                      </option>
                    ))}
                  </select>
                  {hasFilters(filters) ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setFilters(NO_FILTERS);
                      }}
                    >
                      {t('mcpCatalog.clear')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div
              className="mc-body"
              id={PANEL_ID}
              role="tabpanel"
              aria-labelledby={tabId('mcp', tab)}
            >
              {tab === 'catalog' ? (
                list.length === 0 ? (
                  <div className="mk-empty" role="status">
                    <div className="text-sm font-semibold">{t('mcpCatalog.emptyTitle')}</div>
                    <div className="mk-meta">{t('mcpCatalog.emptyBody')}</div>
                  </div>
                ) : (
                  <div className="card mc-table">
                    <div className="mc-tr mc-th" aria-hidden="true">
                      <span>{t('mcpCatalog.table.mcp')}</span>
                      <span>{t('mcpCatalog.table.status')}</span>
                      <span>{t('mcpCatalog.table.level')}</span>
                      <span>{t('mcpCatalog.table.tools')}</span>
                      <span>{t('mcpCatalog.table.agents')}</span>
                      <span>{t('mcpCatalog.table.health')}</span>
                    </div>
                    {list.map((server) => (
                      <ServerRow key={server.id} server={server} onOpen={setSelected} />
                    ))}
                  </div>
                )
              ) : tab === 'tools' ? (
                <ToolsTable rows={tools} onOpen={setSelected} />
              ) : tab === 'remote' ? (
                remote.state.kind === 'error' ? (
                  <GovErrorState
                    title={t('remoteMcp.loadError')}
                    body={t('admin.errors.unavailable')}
                    onRetry={remote.retry}
                  />
                ) : remoteData === null ? (
                  <div role="status" aria-label={t('remoteMcp.loading')}>
                    <Skel h={160} className="rounded-xl" />
                  </div>
                ) : (
                  <RemoteCatalogTab
                    catalog={remoteData}
                    onOpen={(profileId) => {
                      openRemote(profileId);
                    }}
                  />
                )
              ) : (
                <>
                  {remoteData ? (
                    <RemoteRequests catalog={remoteData} meId={me.user_id} onOpen={openRemote} />
                  ) : null}
                  {/* Design: the packs' empty state only when nothing at all is waiting. */}
                  {requests.length > 0 || remotePending === 0 ? (
                    <Requests requests={requests} onOpen={setSelected} />
                  ) : null}
                </>
              )}
            </div>
          </>
        )}
      </div>
      {detail ? (
        <McpDetail
          // A new panel per server: its forms never carry over to another one.
          key={detail.id}
          server={detail}
          servers={servers}
          isAdmin={me.is_admin}
          onAction={act}
          onClose={() => {
            setSelected(null);
          }}
        />
      ) : null}
      {remoteDetail && remoteData && target ? (
        <RemoteDetail
          // A new panel per card and row: its forms never carry over to another one.
          key={`${remoteDetail.id}:${target.row ?? ''}`}
          profile={remoteDetail}
          catalog={remoteData}
          initialRow={target.row}
          isAdmin={me.is_admin}
          meId={me.user_id}
          groups={groups}
          onAct={actRemote}
          onClose={() => {
            openRemote();
          }}
        />
      ) : null}
      {stack}
    </>
  );
}
