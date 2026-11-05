import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { isChatable } from '../../agents/agents';
import { useSession } from '../../auth/useSession';
import { useToasts } from '../../components/admin/useToasts';
import { FilterIcon, KanbanIcon, ListIcon, PlusIcon, SearchIcon } from '../../components/icons';
import { OpsState } from '../../components/ops/OpsState';
import { Topbar } from '../../components/Topbar';
import { readPreference, writePreference } from '../../preferences/storage';
import { NewTicketModal, type NewTicket } from './NewTicketModal';
import { TicketFilters, TicketKanban, TicketList, TicketsFilteredEmpty } from './TicketBoard';
import { TicketPanel, type TicketPatch } from './TicketPanel';
import {
  DEFAULT_SORT,
  MAX_QUERY,
  NO_FILTERS,
  QUICK_VIEWS,
  canMoveTo,
  errorKey,
  filterCount,
  listed,
  parseTicketId,
  shortId,
  summaryOf,
  withTicket,
  type ChosenStatus,
  type Filters,
  type QuickView,
  type Sort,
  type Status,
  type Ticket,
  type TicketDetail,
} from './model';

type Load =
  { kind: 'loading' } | { kind: 'error' } | { kind: 'denied' } | { kind: 'ready'; items: Ticket[] };

type Layout = 'kanban' | 'list';

function savedLayout(): Layout {
  return readPreference('mango-tk-view') === 'list' ? 'list' : 'kanban';
}

/**
 * Tickets (design tickets.jsx, D112): the tickets the person may see, as a board or a list, with
 * the detail of one in a side panel at `/tickets/{id}`. The API decides what is listed and what
 * may change (Cedar, ticket by ticket); search and filters run over that list in the page.
 */
export function TicketsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // `/tickets/{id}` opens its panel; anything after the id is not a ticket.
  const rest = useParams()['*'] ?? '';
  const rawId = rest ? rest : undefined;
  const { api, me, agents } = useSession();
  const { notify, stack } = useToasts();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [layout, setLayout] = useState<Layout>(savedLayout);
  const [q, setQ] = useState('');
  const [quick, setQuick] = useState<QuickView>('all');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [creating, setCreating] = useState<ChosenStatus | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.call('listTickets', {}, { signal: controller.signal }).then(
      (data) => {
        setLoad({ kind: 'ready', items: data.items });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ kind: (error as { status?: unknown }).status === 403 ? 'denied' : 'error' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, attempt]);

  const reload = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);
  const retry = useCallback(() => {
    setLoad({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const agentsById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const usableAgents = useMemo(() => (agents ?? []).filter(isChatable), [agents]);
  const usable = useMemo(
    () => (agents ? new Set(usableAgents.map((agent) => agent.id)) : null),
    [agents, usableAgents],
  );

  const items = load.kind === 'ready' ? load.items : null;
  const view = useMemo(
    () => (items ? listed(items, q, filters, quick, me.user_id) : null),
    [items, q, filters, quick, me.user_id],
  );
  const count = filterCount(filters);
  const anyFilter = q.trim() !== '' || count > 0 || quick !== 'all';

  const replace = useCallback((detail: TicketDetail) => {
    setLoad((current) =>
      current.kind === 'ready'
        ? { kind: 'ready', items: withTicket(current.items, summaryOf(detail)) }
        : current,
    );
  }, []);

  /** PATCH with the version that was read; a refused change says why and nothing is kept. */
  const change = useCallback(
    (ticket: Pick<Ticket, 'ticket_id' | 'version'>, patch: TicketPatch) =>
      api
        .call('changeTicket', {
          path: { ticket_id: ticket.ticket_id },
          body: { version: ticket.version, ...patch },
        })
        .then(
          (detail) => {
            replace(detail);
            if (patch.status) {
              notify(
                t('tickets.moved', {
                  id: shortId(detail.ticket_id),
                  status: t(`tickets.status.${detail.status}`),
                }),
                'success',
              );
            }
            return detail;
          },
          (error: unknown) => {
            notify(t(errorKey(error)), 'error');
            // Someone else changed it: what is shown is read again.
            if ((error as { status?: unknown }).status === 409) reload();
            return null;
          },
        ),
    [api, notify, reload, replace, t],
  );

  const move = (ticket: Ticket, status: Status) => {
    if (!canMoveTo(ticket, status) || status === 'needs_approval') return;
    void change(ticket, { status });
  };

  const open = (ticketId: string) => {
    void navigate(`/tickets/${ticketId}`);
  };
  const close = () => {
    void navigate('/tickets');
  };

  const create = (ticket: NewTicket) => {
    setCreateBusy(true);
    setCreateError(null);
    api
      .call('createNewTicket', {
        body: {
          title: ticket.title,
          description: ticket.description,
          priority: ticket.priority,
          status: ticket.status,
          agent_id: ticket.agentId,
          assign_to_me: ticket.assignToMe,
        },
      })
      .then(
        (detail) => {
          replace(detail);
          setCreating(null);
          notify(t('tickets.create.created', { id: shortId(detail.ticket_id) }), 'success');
        },
        (error: unknown) => {
          setCreateError(t(errorKey(error)));
        },
      )
      .finally(() => {
        setCreateBusy(false);
      });
  };

  const startCreate = (status: Status = 'open') => {
    setCreateError(null);
    setCreating(status === 'needs_approval' ? 'open' : status);
  };

  const newButton = (
    <button
      type="button"
      className="btn btn-sm btn-primary"
      onClick={() => {
        startCreate();
      }}
    >
      <PlusIcon size={12} /> {t('tickets.newTicket')}
    </button>
  );
  const actions = (
    <>
      <div className="mk-seg" role="group" aria-label={t('tickets.view.label')}>
        {(['kanban', 'list'] as const).map((key) => {
          const Icon = key === 'kanban' ? KanbanIcon : ListIcon;
          const label = t(key === 'kanban' ? 'tickets.view.board' : 'tickets.view.list');
          return (
            <button
              key={key}
              type="button"
              className={layout === key ? 'is-on' : ''}
              aria-pressed={layout === key}
              aria-label={label}
              title={label}
              onClick={() => {
                setLayout(key);
                writePreference('mango-tk-view', key);
              }}
            >
              <Icon size={13} />
            </button>
          );
        })}
      </div>
      {newButton}
    </>
  );

  const panel = rawId !== undefined && (
    <TicketPanel
      key={rawId}
      api={api}
      me={me}
      ticketId={parseTicketId(rawId)}
      agents={agentsById}
      usable={usable}
      onClose={close}
      onChange={change}
      onCommented={replace}
      notify={notify}
    />
  );
  const modal = creating !== null && (
    <NewTicketModal
      agents={usableAgents}
      initialStatus={creating}
      busy={createBusy}
      error={createError}
      onClose={() => {
        setCreating(null);
      }}
      onCreate={create}
    />
  );

  if (load.kind !== 'ready' || load.items.length === 0) {
    const kind = load.kind === 'ready' ? 'empty' : load.kind === 'denied' ? 'denied' : load.kind;
    return (
      <>
        <Topbar crumbs={[t('nav.tickets')]} actions={kind === 'empty' ? actions : undefined} />
        <div className="content">
          <OpsState view="tickets" kind={kind} onRetry={retry} action={newButton} />
        </div>
        {panel}
        {modal}
        {stack}
      </>
    );
  }

  return (
    <>
      <Topbar crumbs={[t('nav.tickets')]} actions={actions} />
      <div className="content tk-content">
        <div className="tk-bar">
          <div className="search-wrap tk-search">
            <SearchIcon size={13} />
            <input
              className="input"
              type="search"
              placeholder={t('tickets.search.placeholder')}
              aria-label={t('tickets.search.label')}
              maxLength={MAX_QUERY}
              value={q}
              onChange={(event) => {
                setQ(event.target.value);
              }}
            />
          </div>
          <div className="tk-quick" role="group" aria-label={t('tickets.quick.label')}>
            {QUICK_VIEWS.map((key) => (
              <button
                key={key}
                type="button"
                className={quick === key ? 'is-on' : ''}
                aria-pressed={quick === key}
                onClick={() => {
                  setQuick(key);
                }}
              >
                {t(`tickets.quick.${key}`)}
                <span className="mk-count">{view?.counts[key] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="tk-rel">
            <button
              type="button"
              className={count ? 'btn btn-sm mk-active' : 'btn btn-sm'}
              aria-expanded={filtersOpen}
              onClick={() => {
                setFiltersOpen((value) => !value);
              }}
            >
              <FilterIcon size={12} /> {t('tickets.filters.button')}
              {count > 0 && <span className="mk-count">{count}</span>}
            </button>
            {filtersOpen && (
              <TicketFilters
                filters={filters}
                onChange={setFilters}
                agents={usableAgents}
                onClose={() => {
                  setFiltersOpen(false);
                }}
              />
            )}
          </div>
          <div className="tk-grow" />
          <span className="tk-meta" aria-live="polite">
            {t('tickets.count', { count: view?.shown.length ?? 0 })}
          </span>
          {anyFilter && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setQ('');
                setQuick('all');
                setFilters(NO_FILTERS);
              }}
            >
              {t('tickets.clear')}
            </button>
          )}
        </div>

        {layout === 'kanban' ? (
          <TicketKanban
            tickets={view?.shown ?? []}
            agents={agentsById}
            onOpen={open}
            onMove={move}
            onCreate={startCreate}
          />
        ) : view && view.shown.length > 0 ? (
          <TicketList
            tickets={view.shown}
            agents={agentsById}
            sort={sort}
            onSort={setSort}
            onOpen={open}
          />
        ) : (
          <TicketsFilteredEmpty
            onClear={() => {
              setQ('');
              setQuick('all');
              setFilters(NO_FILTERS);
            }}
          />
        )}
      </div>
      {panel}
      {modal}
      {stack}
    </>
  );
}
