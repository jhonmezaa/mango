import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Agent } from '../../agents/agents';
import { ChevronDownIcon, PlusIcon, WarnIcon } from '../../components/icons';
import { formatRelative } from '../../lib/format';
import { TicketAgent, TicketAvatar, TicketPriority } from './TicketBits';
import {
  NO_FILTERS,
  PRIORITIES,
  STATUSES,
  boardOrder,
  canMoveTo,
  personLabel,
  shortId,
  sorted,
  statusDot,
  type Filters,
  type Priority,
  type Sort,
  type SortKey,
  type Status,
  type Ticket,
} from './model';

type AgentsById = ReadonlyMap<string, Agent>;

/** Design `Kanban`: four columns; a card moves by dragging it (or from its panel). */
export function TicketKanban({
  tickets,
  agents,
  onOpen,
  onMove,
  onCreate,
}: {
  tickets: readonly Ticket[];
  agents: AgentsById;
  onOpen: (ticketId: string) => void;
  onMove: (ticket: Ticket, status: Status) => void;
  onCreate: (status: Status) => void;
}) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState<Ticket | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  return (
    <div className="tk-board">
      {STATUSES.map((column) => {
        const items = tickets.filter((ticket) => ticket.status === column.key).sort(boardOrder);
        // «Por aprobar» is marked by a request of Aprobaciones: never a target.
        const locked = column.key === 'needs_approval';
        const accepts = dragging !== null && canMoveTo(dragging, column.key);
        const label = t(`tickets.status.${column.key}`);
        return (
          <section
            key={column.key}
            aria-label={label}
            className={over === column.key ? 'tk-col is-over' : 'tk-col'}
            onDragOver={(event) => {
              if (!accepts) return;
              event.preventDefault();
              setOver(column.key);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging && accepts) onMove(dragging, column.key);
              setDragging(null);
              setOver(null);
            }}
          >
            <div className="tk-col-h">
              <span className="tk-dot" style={{ background: column.dot }} />
              <span className="tk-col-t">{label}</span>
              <span className="tk-col-n">{items.length}</span>
              {!locked && (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon tk-col-add"
                  aria-label={t('tickets.column.add', { column: label })}
                  title={t('tickets.column.addTitle')}
                  onClick={() => {
                    onCreate(column.key);
                  }}
                >
                  <PlusIcon size={12} />
                </button>
              )}
            </div>
            <div className="tk-col-b">
              {items.map((ticket) => (
                <div
                  key={ticket.ticket_id}
                  className={
                    dragging?.ticket_id === ticket.ticket_id
                      ? 'card tk-card is-drag'
                      : 'card tk-card'
                  }
                  draggable
                  role="button"
                  tabIndex={0}
                  aria-label={`${shortId(ticket.ticket_id)}: ${ticket.title}`}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    setDragging(ticket);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onClick={() => {
                    onOpen(ticket.ticket_id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onOpen(ticket.ticket_id);
                    }
                  }}
                >
                  <div className="tk-card-top">
                    <span className="tk-id">{shortId(ticket.ticket_id)}</span>
                    <TicketPriority priority={ticket.priority} label={false} />
                  </div>
                  <div className="tk-title">{ticket.title}</div>
                  {ticket.status === 'needs_approval' && (
                    <div className="tk-flag">
                      <WarnIcon size={11} /> {t('tickets.column.flag')}
                    </div>
                  )}
                  <div className="tk-card-foot">
                    <TicketAgent
                      ticket={ticket}
                      agent={ticket.agent_id ? agents.get(ticket.agent_id) : undefined}
                      small
                    />
                    <div className="tk-card-side">
                      <span className="tk-meta">{formatRelative(ticket.created_at)}</span>
                      <TicketAvatar person={ticket.assignee} />
                    </div>
                  </div>
                </div>
              ))}
              {items.length === 0 && (
                <div className="tk-empty-col">
                  {dragging
                    ? locked
                      ? t('tickets.column.dropLocked')
                      : accepts
                        ? t('tickets.column.drop')
                        : t('tickets.column.empty')
                    : locked
                      ? t('tickets.column.lockedEmpty')
                      : t('tickets.column.empty')}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const COLUMNS: readonly SortKey[] = ['id', 'title', 'agent', 'status', 'prio', 'age', 'assignee'];
const COLUMN_LABEL = {
  id: 'tickets.list.id',
  title: 'tickets.list.title',
  agent: 'tickets.list.agent',
  status: 'tickets.list.status',
  prio: 'tickets.list.priority',
  age: 'tickets.list.age',
  assignee: 'tickets.list.assignee',
} as const satisfies Record<SortKey, string>;

/** Design `TicketList`: the same tickets as a table, sorted by any column. */
export function TicketList({
  tickets,
  agents,
  sort,
  onSort,
  onOpen,
}: {
  tickets: readonly Ticket[];
  agents: AgentsById;
  sort: Sort;
  onSort: (sort: Sort) => void;
  onOpen: (ticketId: string) => void;
}) {
  const { t } = useTranslation();
  const list = sorted(tickets, sort);
  return (
    <div className="tk-listwrap">
      <div className="card tk-list" role="table" aria-label={t('tickets.view.list')}>
        <div className="tk-tr tk-head" role="row">
          {COLUMNS.map((key) => (
            <button
              key={key}
              type="button"
              role="columnheader"
              className={sort.key === key ? 'tk-th is-on' : 'tk-th'}
              aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
              onClick={() => {
                onSort({ key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : 1 });
              }}
            >
              {t(COLUMN_LABEL[key])}
              {sort.key === key && (
                <ChevronDownIcon
                  size={10}
                  style={sort.dir === 1 ? undefined : { transform: 'rotate(180deg)' }}
                />
              )}
            </button>
          ))}
        </div>
        {list.map((ticket) => (
          <button
            key={ticket.ticket_id}
            type="button"
            role="row"
            className="tk-tr"
            onClick={() => {
              onOpen(ticket.ticket_id);
            }}
          >
            <span role="cell" className="tk-id">
              {shortId(ticket.ticket_id)}
            </span>
            <span role="cell" className="tk-cell-title">
              {ticket.title}
            </span>
            <span role="cell">
              <TicketAgent
                ticket={ticket}
                agent={ticket.agent_id ? agents.get(ticket.agent_id) : undefined}
                small
              />
            </span>
            <span role="cell" className="tk-row tk-st">
              <span className="tk-dot" style={{ background: statusDot(ticket.status) }} />
              {t(`tickets.status.${ticket.status}`)}
            </span>
            <span role="cell">
              <TicketPriority priority={ticket.priority} />
            </span>
            <span role="cell" className="tk-meta">
              {formatRelative(ticket.created_at)}
            </span>
            <span role="cell" className="tk-cell-who">
              <TicketAvatar person={ticket.assignee} />
              <span className="tk-meta tk-trunc">
                {ticket.assignee ? personLabel(ticket.assignee) : '—'}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Design `TkEmpty`: nothing matches the search or the filters. */
export function TicketsFilteredEmpty({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="mk-empty">
      <div className="ops-state-t">{t('tickets.empty.filteredTitle')}</div>
      <div className="mk-meta">{t('tickets.empty.filteredBody')}</div>
      <button type="button" className="btn btn-sm" onClick={onClear}>
        {t('tickets.empty.clearFilters')}
      </button>
    </div>
  );
}

/** Design `FiltersPopover`: status, priority, agent and «Asignado a». */
export function TicketFilters({
  filters,
  onChange,
  agents,
  onClose,
}: {
  filters: Filters;
  onChange: (filters: Filters) => void;
  agents: readonly Agent[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toggleStatus = (value: Status) => {
    const next = new Set(filters.status);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange({ ...filters, status: next });
  };
  const togglePriority = (value: Priority) => {
    const next = new Set(filters.priority);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange({ ...filters, priority: next });
  };
  return (
    <>
      <div className="tk-pop-scrim" aria-hidden="true" onClick={onClose} />
      <div
        className="card mk-pop tk-pop"
        role="dialog"
        aria-label={t('tickets.filters.title')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="tk-pop-h">
          <span>{t('tickets.filters.title')}</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              onChange(NO_FILTERS);
            }}
          >
            {t('tickets.filters.clear')}
          </button>
        </div>
        <div className="tk-fl">{t('tickets.filters.status')}</div>
        <div className="tk-pop-chips">
          {STATUSES.map((status) => (
            <button
              key={status.key}
              type="button"
              className={filters.status.has(status.key) ? 'tk-chip is-on' : 'tk-chip'}
              aria-pressed={filters.status.has(status.key)}
              onClick={() => {
                toggleStatus(status.key);
              }}
            >
              <span className="tk-dot" style={{ background: status.dot }} />
              {t(`tickets.status.${status.key}`)}
            </button>
          ))}
        </div>
        <div className="tk-fl">{t('tickets.filters.priority')}</div>
        <div className="tk-pop-chips">
          {PRIORITIES.map((priority) => (
            <button
              key={priority.key}
              type="button"
              className={filters.priority.has(priority.key) ? 'tk-chip is-on' : 'tk-chip'}
              aria-pressed={filters.priority.has(priority.key)}
              onClick={() => {
                togglePriority(priority.key);
              }}
            >
              <span className="tk-dot" style={{ background: priority.dot }} />
              {t(`tickets.priority.${priority.key}`)}
            </button>
          ))}
        </div>
        <label className="tk-fl" htmlFor="tk-f-agent">
          {t('tickets.filters.agent')}
        </label>
        <select
          id="tk-f-agent"
          className="input tk-pop-sel"
          value={filters.agent}
          onChange={(event) => {
            onChange({ ...filters, agent: event.target.value });
          }}
        >
          <option value="all">{t('tickets.filters.allAgents')}</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <label className="tk-fl" htmlFor="tk-f-as">
          {t('tickets.filters.assignee')}
        </label>
        <select
          id="tk-f-as"
          className="input tk-pop-sel"
          value={filters.assignee}
          onChange={(event) => {
            const value = event.target.value;
            onChange({
              ...filters,
              assignee: value === 'none' || value === 'me' ? value : 'all',
            });
          }}
        >
          <option value="all">{t('tickets.filters.anyone')}</option>
          <option value="none">{t('tickets.filters.none')}</option>
          <option value="me">{t('tickets.filters.me')}</option>
        </select>
      </div>
    </>
  );
}
