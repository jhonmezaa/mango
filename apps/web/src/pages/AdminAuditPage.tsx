import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import { ApiError } from '../api/errors';
import type { AuditEvent } from '../api/schemas';
import { useSession } from '../auth/useSession';
import { AuditDrawer } from '../components/admin/AuditDrawer';
import {
  AUDIT_CATEGORIES,
  TONE_COLOR,
  csvCell,
  dayKey,
  groupTurnAuthz,
  isPermAction,
  outcomeClass,
  toAuditRow,
  type AuditCategory,
  type AuditRow,
} from '../components/admin/auditModel';
import { usd } from '../components/admin/govFormat';
import { Denied, GovErrorState, Skel } from '../components/admin/govKit';
import { useToasts } from '../components/admin/useToasts';
import { CloseIcon, DownloadIcon, SearchIcon, ShieldIcon } from '../components/icons';
import { Soon } from '../components/Soon';
import { Topbar } from '../components/Topbar';
import { copyText } from '../lib/clipboard';

const RANGES = [
  { key: '24h', ms: 86_400_000 },
  { key: '7d', ms: 7 * 86_400_000 },
  { key: '30d', ms: 30 * 86_400_000 },
  { key: 'all', ms: Number.POSITIVE_INFINITY },
] as const;
type Range = (typeof RANGES)[number]['key'];

/** Rows shown per step (design `limit`) and the API page size (GET /api/admin/audit ≤ 200). */
const PAGE = 40;
const API_PAGE = 100;

type LoadState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      items: AuditEvent[];
      /** Cursor of the next server page; null when the server has nothing older. */
      next: string | null;
      since: Date | null;
      excludeReads: boolean;
      loadedAt: number;
    }
  | { kind: 'error'; forbidden: boolean };

function sinceOf(range: Range, now: number): Date | null {
  const ms = RANGES.find((item) => item.key === range)?.ms ?? Number.POSITIVE_INFINITY;
  return Number.isFinite(ms) ? new Date(now - ms) : null;
}

const timeFormat = new Intl.DateTimeFormat('es-MX', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const fullFormat = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'medium' });
const dayFormat = new Intl.DateTimeFormat('es-MX', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const isCategory = (value: string | null): value is AuditCategory =>
  (AUDIT_CATEGORIES as readonly string[]).includes(value ?? '');

/**
 * Audit log (design audit-budgets.jsx `AuditLog`): events of GET /api/admin/audit grouped by
 * day, with categories, period, actor and resource filters, a side panel and a CSV of what is
 * loaded. The period and "Mostrar lecturas" (off by default: `exclude=reads`) are applied by the
 * server; older events arrive page by page with the API cursor. "Verificar integridad" has no
 * backend yet ("Próximamente").
 */
export function AdminAuditPage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { notify, stack } = useToasts();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState('');
  const [actor, setActor] = useState<string | null>(null);
  const [category, setCategory] = useState<AuditCategory | 'all'>(() => {
    const initial = params.get('cat');
    return isCategory(initial) ? initial : 'all';
  });
  const [range, setRange] = useState<Range>('all');
  const [reads, setReads] = useState(false);
  const [resource, setResource] = useState<{ key: string; id: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  // Bumped by every first-page load: a later page that arrives after it is discarded.
  const generation = useRef(0);

  // First page for the period (and "Reintentar"). Later pages are fetched by `loadMore`, so a
  // failure there keeps what is already on screen.
  useEffect(() => {
    if (!me.is_admin) return;
    let cancelled = false;
    generation.current += 1;
    const since = sinceOf(range, Date.now());
    const excludeReads = !reads;
    api.listAuditEvents({ limit: API_PAGE, since, excludeReads }).then(
      (page) => {
        if (cancelled) return;
        setState({
          kind: 'ready',
          items: page.items,
          next: page.next_cursor,
          since,
          excludeReads,
          loadedAt: Date.now(),
        });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', forbidden: error instanceof ApiError && error.status === 403 });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, me.is_admin, reloadToken, range, reads]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setReloadToken((value) => value + 1);
  }, []);

  const changeRange = (next: Range) => {
    if (next === range) return;
    setRange(next);
    setState({ kind: 'loading' });
  };

  const changeReads = (next: boolean) => {
    if (next === reads) return;
    setReads(next);
    setState({ kind: 'loading' });
  };

  const loadMore = () => {
    if (state.kind !== 'ready' || state.next === null) return;
    const current = state;
    const token = generation.current;
    setLoadingMore(true);
    api
      .listAuditEvents({
        limit: API_PAGE,
        since: current.since,
        excludeReads: current.excludeReads,
        cursor: current.next,
      })
      .then(
        (page) => {
          // A new period or a "Reintentar" started meanwhile owns the list now.
          if (generation.current !== token) return;
          setState({
            ...current,
            items: [...current.items, ...page.items],
            next: page.next_cursor,
          });
          // The same "Mostrar más" also reveals the next step of what just arrived.
          setShown((value) => value + PAGE);
        },
        () => {
          if (generation.current === token) notify(t('audit.loadMoreError'), 'error');
        },
      )
      .finally(() => {
        setLoadingMore(false);
      });
  };

  const all = useMemo(
    () => (state.kind === 'ready' ? groupTurnAuthz(state.items.map(toAuditRow)) : []),
    [state],
  );

  const roleOf = useCallback(
    (row: AuditRow) => (row.role ? t(`audit.roles.${row.role}`) : ''),
    [t],
  );
  const labelOf = useCallback(
    (row: AuditRow) => (row.known ? t(`audit.actions.${row.known}`) : row.event),
    [t],
  );
  const detailOf = useCallback(
    (row: AuditRow) => {
      const d = row.detail;
      const text =
        d.kind === 'defaults'
          ? t('audit.detail.defaults', {
              user: d.user ? usd(d.user) : '—',
              agent: d.agent ? usd(d.agent) : '—',
            })
          : d.kind === 'userDefault'
            ? t('audit.detail.userDefault')
            : d.kind === 'userOwn'
              ? t('audit.detail.userOwn', { amount: usd(d.amount) })
              : d.kind === 'propose'
                ? t('audit.detail.propose', { reason: d.reason })
                : d.kind === 'approve'
                  ? d.version === null
                    ? t('audit.detail.approveNoVersion')
                    : t('audit.detail.approve', { version: d.version })
                  : d.kind === 'reject'
                    ? t('audit.detail.reject', { reason: d.reason })
                    : d.kind === 'withdraw'
                      ? t('audit.detail.withdraw', { id: d.changeId })
                      : d.kind === 'access'
                        ? t(d.allowed ? 'audit.detail.accessView' : 'audit.detail.accessDenied', {
                            action: isPermAction(d.action)
                              ? t(`audit.perms.${d.action}`)
                              : d.action,
                          })
                        : d.kind === 'chat'
                          ? [
                              t('audit.detail.chat', { agent: d.agent, count: d.tools }),
                              ...(d.cost
                                ? [t('audit.detail.chatCost', { amount: usd(d.cost) })]
                                : []),
                            ].join(' · ')
                          : d.kind === 'catalogSync'
                            ? d.added > 0
                              ? t('audit.detail.catalogSync', { count: d.added })
                              : t('audit.detail.catalogSyncNone')
                            : d.text;
      return text;
    },
    [t],
  );
  // Design `auditOutcome`: what the API recorded about the write, plus its error code.
  const outcomeOf = useCallback(
    (row: AuditRow) =>
      row.outcome
        ? `${t(`audit.outcome.${row.outcome}`)}${row.error ? ` · ${row.error}` : ''}`
        : '',
    [t],
  );

  const actors = useMemo(() => {
    const values = new Set(all.map((row) => row.actor));
    if (actor !== null) values.add(actor);
    return [...values].sort((a, b) => a.localeCompare(b, 'es'));
  }, [all, actor]);

  // "Hoy"/"Ayer" are relative to when the events were loaded (pure render); the period itself
  // was applied by the server.
  const now = state.kind === 'ready' ? state.loadedAt : 0;
  const needle = query.trim().toLowerCase();
  const base = all.filter(
    (row) =>
      (actor === null || row.actor === actor) &&
      (resource === null || row.resourceKey === resource.key) &&
      (!needle ||
        [
          row.raw.event_id,
          row.actor,
          row.resource ?? '',
          detailOf(row),
          outcomeOf(row),
          labelOf(row),
          row.event,
        ]
          .join(' ')
          .toLowerCase()
          .includes(needle)),
  );
  const rows = base.filter((row) => category === 'all' || row.category === category);
  const countOf = (key: AuditCategory) => base.filter((row) => row.category === key).length;
  const anyFilter =
    needle !== '' ||
    actor !== null ||
    category !== 'all' ||
    range !== 'all' ||
    reads ||
    resource !== null;

  // A new filter starts again from the first page (design `setLimit(40)`).
  const filterKey = `${needle}|${actor ?? ''}|${category}|${range}|${String(reads)}|${resource?.key ?? ''}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setShown(PAGE);
  }

  const clear = () => {
    setQuery('');
    setActor(null);
    setCategory('all');
    changeRange('all');
    changeReads(false);
    setResource(null);
  };

  const visible = rows.slice(0, shown);
  const today = dayKey(now);
  const dayLabel = (key: number) => {
    if (key === today) return t('audit.today');
    if (key === dayKey(today - 43_200_000)) return t('audit.yesterday');
    const text = dayFormat.format(new Date(key));
    return text.charAt(0).toUpperCase() + text.slice(1);
  };
  const groups: { key: number; items: AuditRow[] }[] = [];
  for (const row of visible) {
    const key = dayKey(row.time);
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(row);
    else groups.push({ key, items: [row] });
  }
  // One "Mostrar más" (design v13, no count): the next local step, then the next server page.
  const hasMoreLocal = rows.length > shown;
  const canLoadMore = state.kind === 'ready' && state.next !== null;
  const showMore = () => {
    if (hasMoreLocal) setShown((value) => value + PAGE);
    else loadMore();
  };
  const selectedRow = selected ? all.find((row) => row.key === selected) : undefined;

  const exportCsv = () => {
    const header = t('audit.csvHeader');
    const lines = rows.map((row) =>
      [
        row.raw.event_id,
        row.ts,
        row.actor,
        roleOf(row),
        labelOf(row),
        row.event,
        row.resource ?? '',
        detailOf(row),
        outcomeOf(row),
        row.before ? JSON.stringify(row.before) : '',
        row.after ? JSON.stringify(row.after) : '',
        row.raw.hash,
      ]
        .map(csvCell)
        .join(','),
    );
    const csv = [header, ...lines].join('\n');
    const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `mango-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    // Some browsers start the download asynchronously: revoking in the same tick can cancel it.
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
    notify(t('audit.exported', { count: rows.length }));
  };

  const linkOf = (row: AuditRow) =>
    row.category === 'budgets'
      ? { to: '/budgets', label: t('audit.links.budgets') }
      : // Design `AUDIT_LINK`: the people of the directory are managed in Ajustes too.
        row.category === 'config' || row.action.startsWith('directory.')
        ? { to: '/settings', label: t('audit.links.settings') }
        : null;

  const crumbs = [t('audit.crumbGov'), t('audit.crumb')];

  // UX gate only; GET /api/admin/audit enforces admin on the server (REACT-AUTHZ-001).
  if (!me.is_admin || (state.kind === 'error' && state.forbidden)) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <Denied />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        crumbs={crumbs}
        actions={
          <>
            <Soon name={t('audit.verify')} className="gov-topbar-soon">
              <button type="button" className="btn btn-sm" tabIndex={-1}>
                <ShieldIcon size={12} />
                {t('audit.verify')}
              </button>
            </Soon>
            <button
              type="button"
              className="btn btn-sm"
              disabled={rows.length === 0}
              onClick={exportCsv}
            >
              <DownloadIcon size={12} />
              {t('audit.export')}
            </button>
          </>
        }
      />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t('audit.title')}</h1>
          <p className="page-subtitle">{t('audit.subtitle')}</p>
        </div>

        <div className="au-bar">
          <div className="au-row">
            <div className="search-wrap max-w-[340px] flex-[1_1_240px]">
              <SearchIcon size={13} />
              <input
                className="input"
                aria-label={t('audit.searchLabel')}
                placeholder={t('audit.search')}
                maxLength={200}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
            </div>
            <div className="tk-quick" role="group" aria-label={t('audit.rangeLabel')}>
              {RANGES.map(({ key }) => (
                <button
                  key={key}
                  type="button"
                  className={range === key ? 'is-on' : ''}
                  aria-pressed={range === key}
                  onClick={() => {
                    changeRange(key);
                  }}
                >
                  {t(`audit.ranges.${key}`)}
                </button>
              ))}
            </div>
            <select
              className="input mk-sel"
              aria-label={t('audit.actorLabel')}
              value={actor ?? '__all__'}
              onChange={(event) => {
                setActor(event.target.value === '__all__' ? null : event.target.value);
              }}
            >
              <option value="__all__">{t('audit.anyActor')}</option>
              {actors.map((value) => (
                <option key={value} value={value}>
                  {value || t('audit.system')}
                </option>
              ))}
            </select>
            {resource !== null && (
              <span className="au-pill">
                {t('audit.resource')} <span className="mono">{resource.id}</span>
                <button
                  type="button"
                  aria-label={t('audit.removeResource')}
                  onClick={() => {
                    setResource(null);
                  }}
                >
                  <CloseIcon size={10} />
                </button>
              </span>
            )}
            <label className="au-reads" title={t('audit.readsTitle')}>
              <button
                type="button"
                role="switch"
                className="au-switch"
                aria-checked={reads}
                onClick={() => {
                  changeReads(!reads);
                }}
              />
              {t('audit.reads')}
            </label>
            <div className="flex-1" />
            <span className="tk-meta">{t('audit.count', { count: rows.length })}</span>
            {anyFilter && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={clear}>
                {t('audit.clear')}
              </button>
            )}
          </div>
          <div className="au-cats" role="group" aria-label={t('audit.categoryLabel')}>
            <button
              type="button"
              className={category === 'all' ? 'is-on' : ''}
              aria-pressed={category === 'all'}
              onClick={() => {
                setCategory('all');
              }}
            >
              {t('audit.categories.all')}
              <span>{base.length}</span>
            </button>
            {AUDIT_CATEGORIES.map((key) => {
              const count = countOf(key);
              return count > 0 || category === key ? (
                <button
                  key={key}
                  type="button"
                  className={category === key ? 'is-on' : ''}
                  aria-pressed={category === key}
                  onClick={() => {
                    setCategory(key);
                  }}
                >
                  {t(`audit.categories.${key}`)}
                  <span>{count}</span>
                </button>
              ) : null;
            })}
          </div>
        </div>

        <div className="au-body" aria-busy={state.kind === 'loading'}>
          {state.kind === 'loading' && (
            <div className="card overflow-hidden p-0" aria-label={t('audit.loading')}>
              {[0, 1, 2, 3, 4].map((index) => (
                <div key={index} className="au-tr" aria-hidden="true">
                  <Skel w={36} />
                  <Skel w="70%" />
                  <Skel w="60%" />
                  <Skel w="50%" />
                  <Skel w="80%" />
                  <span />
                </div>
              ))}
            </div>
          )}
          {state.kind === 'error' && (
            <GovErrorState
              title={t('audit.loadError')}
              body={t('audit.loadErrorBody')}
              onRetry={retry}
            />
          )}
          {state.kind === 'ready' && rows.length === 0 && (
            <div className="mk-empty">
              <div className="text-[14px] font-semibold">{t('audit.empty')}</div>
              <div className="mk-meta">
                {anyFilter ? t('audit.emptyFiltered') : t('audit.emptyAll')}
              </div>
              {anyFilter && (
                <button type="button" className="btn btn-sm" onClick={clear}>
                  {t('audit.clearFilters')}
                </button>
              )}
            </div>
          )}
          {groups.map((group) => (
            <section key={group.key} className="au-day" aria-label={dayLabel(group.key)}>
              <h2 className="au-day-h">
                {dayLabel(group.key)}
                <span>{group.items.length}</span>
              </h2>
              <div className="card overflow-hidden p-0">
                {group.items.map((row) => (
                  <button
                    key={row.key}
                    type="button"
                    className={selected === row.key ? 'au-tr is-on' : 'au-tr'}
                    onClick={() => {
                      setSelected(row.key);
                    }}
                  >
                    <span className="mono au-time" title={fullFormat.format(new Date(row.time))}>
                      {timeFormat.format(new Date(row.time))}
                    </span>
                    <span className="au-ev">
                      <span className="tk-dot" style={{ background: TONE_COLOR[row.tone] }} />
                      {labelOf(row)}
                    </span>
                    <span className="au-actor">
                      <span className="au-name" title={row.actor || undefined}>
                        {row.actor || t('audit.system')}
                      </span>
                      {row.role && <span className="au-role">{roleOf(row)}</span>}
                    </span>
                    <span className="mono au-target">{row.resource ?? '—'}</span>
                    <span className="au-detail">
                      {detailOf(row)}
                      {row.outcome && (
                        <span className={outcomeClass(row)}> · {outcomeOf(row)}</span>
                      )}
                    </span>
                    {row.before || row.after ? (
                      <span className="au-diff" title={t('audit.hasDiff')}>
                        Δ
                      </span>
                    ) : (
                      <span />
                    )}
                  </button>
                ))}
              </div>
            </section>
          ))}
          {hasMoreLocal || canLoadMore ? (
            <button
              type="button"
              className="btn btn-sm mx-auto mt-1 flex"
              disabled={loadingMore}
              onClick={showMore}
            >
              {loadingMore ? t('audit.loadingMore') : t('audit.loadMore')}
            </button>
          ) : null}
        </div>
      </div>
      {selectedRow && (
        <AuditDrawer
          row={selectedRow}
          label={labelOf(selectedRow)}
          role={roleOf(selectedRow)}
          detail={detailOf(selectedRow)}
          outcome={outcomeOf(selectedRow)}
          link={linkOf(selectedRow)}
          onClose={() => {
            setSelected(null);
          }}
          onActor={(value) => {
            setActor(value);
            setSelected(null);
          }}
          onResource={(value) => {
            setResource(value);
            setSelected(null);
          }}
          onLink={(to) => {
            setSelected(null);
            void navigate(to);
          }}
          onCopy={() => {
            void copyText(JSON.stringify(selectedRow.raw, null, 2))
              .then(() => {
                notify(t('audit.copied'));
              })
              .catch(() => {
                notify(t('audit.copyFailed'), 'error');
              });
          }}
        />
      )}
      {stack}
    </>
  );
}
