import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { Denied, GovErrorState, Skel } from '../../components/admin/govKit';
import { useToasts } from '../../components/admin/useToasts';
import { BookOpenIcon, PlusIcon, SearchIcon } from '../../components/icons';
import { SoonTag } from '../../components/Soon';
import { Topbar } from '../../components/Topbar';
import { formatRelative } from '../../lib/format';
import { KbCreate } from './KbCreate';
import { KbDetail } from './KbDetail';
import { StatusBadge } from './parts';
import {
  NO_FILTERS,
  ORIGIN_FILTERS,
  QUERY_MAX_LENGTH,
  STATUS_FILTERS,
  filtered,
  formatBytes,
  formatCount,
  inFilter,
  isSpinning,
  needsAttention,
  ownerName,
  partialAgents,
  searched,
  shownStatus,
  type Filters,
  type KnowledgeBase,
  type KnowledgeList,
  type OriginFilter,
  type ShownStatus,
} from './model';

type LoadState = { kind: 'loading' } | { kind: 'ready'; data: KnowledgeList } | { kind: 'error' };

/** While a knowledge base synchronizes or is being deleted, the list is read again this often. */
const POLL_MS = 5000;

function isOriginFilter(value: string): value is OriginFilter {
  return (ORIGIN_FILTERS as readonly string[]).includes(value);
}

/** The status under the badge (design `kbStatusSub`). */
function StatusSub({ kb, status }: { kb: KnowledgeBase; status: ShownStatus }) {
  const { t } = useTranslation();
  let text = '';
  if ((status === 'ok' || status === 'warn') && kb.last_synced_at)
    text = formatRelative(kb.last_synced_at);
  else if (status === 'blocked') text = t('knowledge.sub.budget');
  else if (status === 'full') text = t('knowledge.sub.full');
  else if (status === 'approval') text = t('knowledge.sub.approval');
  return text ? <span className="kb-sub">{text}</span> : null;
}

function Row({ kb, onOpen }: { kb: KnowledgeBase; onOpen: () => void }) {
  const { t } = useTranslation();
  const status = shownStatus(kb);
  const partial = partialAgents(kb).length > 0;
  const agents = kb.agents?.length ?? 0;
  return (
    <button
      type="button"
      className={status === 'deleting' ? 'kb-tr is-deleting' : 'kb-tr'}
      onClick={onOpen}
    >
      <span className="row min-w-0 gap-3">
        <span className="mc-ic">
          <BookOpenIcon size={14} />
        </span>
        <span className="min-w-0">
          <span className="mk-name block">{kb.name}</span>
          <span className="kb-sub">
            {ownerName(kb)}
            {kb.description ? ` · ${kb.description}` : ''}
          </span>
        </span>
      </span>
      <span className="mk-meta">{t(`knowledge.originShort.${kb.origin}`)}</span>
      <span className="kb-st">
        <StatusBadge kb={kb} />
        <StatusSub kb={kb} status={status} />
      </span>
      <span className="mk-meta mono">
        {kb.documents
          ? t('knowledge.size', {
              documents: formatCount(kb.documents),
              bytes: formatBytes(kb.bytes),
            })
          : '—'}
      </span>
      <span className="row min-w-0 flex-wrap gap-1">
        {kb.groups.slice(0, 2).map((group) => (
          <span key={group} className="mv-cap">
            {group}
          </span>
        ))}
        {kb.groups.length > 2 ? <span className="mk-meta">+{kb.groups.length - 2}</span> : null}
        {partial ? (
          <span className="badge badge-amber" title={t('knowledge.partialTip')}>
            {t('knowledge.partial')}
          </span>
        ) : null}
      </span>
      <span className="mk-meta">{agents || '—'}</span>
    </button>
  );
}

/**
 * Knowledge Bases (design knowledge.jsx, D88): the knowledge bases a creator or administrator
 * sees, their status and, in a panel, their summary and access. The API authorizes and audits
 * every action (`CreateKnowledgeBase`, `EditKnowledgeBase`, …); what is hidden here is only UX.
 * Agent queries over 30 days are "Próximamente".
 */
export function KnowledgePage() {
  const { t } = useTranslation();
  const { api } = useSession();
  const { notify, stack } = useToasts();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [forbidden, setForbidden] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [groups, setGroups] = useState<readonly string[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.call('listKnowledgeBases', {}, { signal: controller.signal }).then(
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

  // The groups to choose from when creating or editing; without them only the chosen ones show.
  useEffect(() => {
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
  }, [api]);

  const items = useMemo(() => (state.kind === 'ready' ? state.data.items : []), [state]);
  const working = items.some((kb) => isSpinning(shownStatus(kb)));

  // The synchronization and the deletion change the status on their own.
  useEffect(() => {
    if (!working) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      api.call('listKnowledgeBases', {}, { signal: controller.signal }).then(
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

  /** Reads the list again after an action; the panel shows what the API answers. */
  const reload = useCallback(async () => {
    const data = await api.call('listKnowledgeBases');
    setState({ kind: 'ready', data });
  }, [api]);

  /** Puts one knowledge base the API answered in the list. */
  const put = useCallback((kb: KnowledgeBase) => {
    setState((current) => {
      if (current.kind !== 'ready') return current;
      const exists = current.data.items.some((item) => item.kb_id === kb.kb_id);
      const items = exists
        ? current.data.items.map((item) => (item.kb_id === kb.kb_id ? kb : item))
        : [...current.data.items, kb];
      return { kind: 'ready', data: { ...current.data, items } };
    });
  }, []);

  const crumbs = [t('knowledge.crumbBuild'), t('knowledge.title')];
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
  const base = searched(items, filters);
  const list = filtered(items, filters);
  const statuses = items.map((kb) => shownStatus(kb));
  const attention = statuses.filter(needsAttention).length;
  const inUse = items.filter((kb) => (kb.agents?.length ?? 0) > 0).length;
  const documents = items.reduce((sum, kb) => sum + kb.documents, 0);
  const bytes = items.reduce((sum, kb) => sum + kb.bytes, 0);
  const detail = selected === null ? null : (items.find((kb) => kb.kb_id === selected) ?? null);
  const patch = (changes: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...changes }));
  };

  return (
    <>
      <Topbar
        crumbs={crumbs}
        actions={
          data?.can_create ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                setCreating(true);
              }}
            >
              <PlusIcon size={12} />
              {t('knowledge.createButton')}
            </button>
          ) : null
        }
      />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('knowledge.title')}</h1>
          <p className="page-subtitle">{t('knowledge.subtitle')}</p>
        </div>
        {state.kind === 'error' ? (
          <div className="mc-body">
            <GovErrorState
              title={t('knowledge.loadError')}
              body={t('admin.errors.unavailable')}
              onRetry={retry}
            />
          </div>
        ) : data === null ? (
          <div className="mc-body" role="status" aria-label={t('knowledge.loading')}>
            <Skel h={84} className="mb-4 rounded-xl" />
            <Skel h={260} className="rounded-xl" />
          </div>
        ) : (
          <>
            <div className="bg-kpis">
              <div className="card bg-kpi">
                <span className="bg-kpi-l">{t('knowledge.kpi.bases')}</span>
                <span className="bg-kpi-v">{items.length}</span>
                <span className="bg-kpi-s">{t('knowledge.kpi.inUse', { count: inUse })}</span>
              </div>
              <div className="card bg-kpi">
                <span className="bg-kpi-l">{t('knowledge.kpi.documents')}</span>
                <span className="bg-kpi-v">{formatCount(documents)}</span>
                <span className="bg-kpi-s">
                  {t('knowledge.kpi.size', { size: formatBytes(bytes) })}
                </span>
              </div>
              <div className="card bg-kpi">
                <span className="bg-kpi-l">{t('knowledge.kpi.attention')}</span>
                <span
                  className="bg-kpi-v"
                  style={attention ? { color: 'var(--amber)' } : undefined}
                >
                  {attention}
                </span>
                <span className="bg-kpi-s">
                  {attention ? t('knowledge.kpi.attentionSome') : t('knowledge.kpi.attentionNone')}
                </span>
              </div>
              <div className="card bg-kpi">
                <span className="bg-kpi-l">{t('knowledge.kpi.queries')}</span>
                <span className="bg-kpi-v" style={{ color: 'var(--text-muted)' }}>
                  —
                </span>
                <span className="bg-kpi-s">
                  <SoonTag />
                </span>
              </div>
            </div>
            <div className="bg-toolbar">
              <div className="search-wrap max-w-[300px] flex-[1_1_220px]">
                <SearchIcon size={13} />
                <input
                  className="input"
                  placeholder={t('knowledge.search')}
                  aria-label={t('knowledge.searchLabel')}
                  maxLength={QUERY_MAX_LENGTH}
                  value={filters.query}
                  onChange={(event) => {
                    patch({ query: event.target.value });
                  }}
                />
              </div>
              <div className="tk-quick" role="group" aria-label={t('knowledge.filterLabel')}>
                {STATUS_FILTERS.map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    className={filters.status === filter ? 'is-on' : undefined}
                    aria-pressed={filters.status === filter}
                    onClick={() => {
                      patch({ status: filter });
                    }}
                  >
                    {t(`knowledge.filters.${filter}`)}
                    <span className="mk-count">
                      {base.filter((kb) => inFilter(shownStatus(kb), filter)).length}
                    </span>
                  </button>
                ))}
              </div>
              <select
                className="input mk-sel"
                aria-label={t('knowledge.originLabel')}
                value={filters.origin}
                onChange={(event) => {
                  const { value } = event.target;
                  patch({ origin: isOriginFilter(value) ? value : 'all' });
                }}
              >
                {ORIGIN_FILTERS.map((origin) => (
                  <option key={origin} value={origin}>
                    {t(`knowledge.origins.${origin}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="mc-body pt-0">
              <div className="card mc-table">
                <div className="kb-tr mc-th">
                  <span>{t('knowledge.columns.name')}</span>
                  <span>{t('knowledge.columns.origin')}</span>
                  <span>{t('knowledge.columns.status')}</span>
                  <span>{t('knowledge.columns.size')}</span>
                  <span>{t('knowledge.columns.access')}</span>
                  <span>{t('knowledge.columns.agents')}</span>
                </div>
                {list.map((kb) => (
                  <Row
                    key={kb.kb_id}
                    kb={kb}
                    onOpen={() => {
                      setSelected(kb.kb_id);
                    }}
                  />
                ))}
                {list.length === 0 ? (
                  <div className="mk-meta p-4">
                    {items.length ? t('knowledge.noMatch') : t('knowledge.none')}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
      {detail ? (
        <KbDetail
          key={detail.kb_id}
          kb={detail}
          groups={groups}
          notify={notify}
          onChanged={put}
          onReload={reload}
          onClose={() => {
            setSelected(null);
          }}
        />
      ) : null}
      {creating ? (
        <KbCreate
          groups={groups}
          onClose={() => {
            setCreating(false);
          }}
          onCreated={(kb, toast) => {
            setCreating(false);
            put(kb);
            notify(toast, 'success');
            // A bucket knowledge base now has its proposal: the list says so.
            if (kb.origin === 'bucket') void reload().catch(() => undefined);
            setSelected(kb.kb_id);
          }}
        />
      ) : null}
      {stack}
    </>
  );
}
