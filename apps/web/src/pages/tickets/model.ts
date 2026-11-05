import type { OperationOutput } from '../../api/operations';

// Tickets (design tickets.jsx, D112). The server lists the tickets the person may see (Cedar,
// ticket by ticket) and derives «Por aprobar» from an open approval of the conversation that
// created it; this module holds what the page decides by itself: the quick views, the filters
// and the search over that list, the order of the board and the list, where a card may be
// dropped and the lines of «Actividad». Nothing here decides access: the API authorizes every
// read and every change, and the UI only hides what it would refuse.

export type TicketList = OperationOutput<'listTickets'>;
export type Ticket = TicketList['items'][number];
export type TicketDetail = OperationOutput<'getTicket'>;
export type TicketEvent = TicketDetail['history'][number];
export type Person = Ticket['creator'];
export type Status = Ticket['status'];
export type Priority = Ticket['priority'];
/** What a person may choose: «Por aprobar» only comes from Aprobaciones (422 otherwise). */
export type ChosenStatus = Exclude<Status, 'needs_approval'>;
export type QuickView = 'all' | 'mine' | 'unassigned' | 'high';

/** Columns of the board, in the design's order, with the color of their dot. */
export const STATUSES: readonly { key: Status; dot: string }[] = [
  { key: 'open', dot: 'var(--text-dim)' },
  { key: 'in_progress', dot: 'var(--blue)' },
  { key: 'needs_approval', dot: 'var(--amber)' },
  { key: 'done', dot: 'var(--green)' },
];

export const PRIORITIES: readonly { key: Priority; dot: string; weight: 1 | 2 | 3 }[] = [
  { key: 'high', dot: 'var(--red)', weight: 3 },
  { key: 'medium', dot: 'var(--amber)', weight: 2 },
  { key: 'low', dot: 'var(--text-dim)', weight: 1 },
];

export const CHOSEN_STATUSES: readonly ChosenStatus[] = ['open', 'in_progress', 'done'];
export const QUICK_VIEWS: readonly QuickView[] = ['all', 'mine', 'unassigned', 'high'];

/** As the API (`mango_core.tickets`). */
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 8000;
export const MAX_COMMENT = 4000;
export const MAX_QUERY = 100;

/** The API's ticket id (`ID_PATTERN`): a path that is not one opens nothing. */
const TICKET_ID = /^[a-z2-7]{12}$/;

/** A ticket id taken from the URL, or null when it is not one (it never reaches a request). */
export function parseTicketId(value: unknown): string | null {
  return typeof value === 'string' && TICKET_ID.test(value) ? value : null;
}

/** Design `tkShort`: the id is random; its first eight characters are what people read. */
export function shortId(ticketId: string): string {
  return ticketId.slice(0, 8);
}

export function priorityWeight(priority: Priority): number {
  return PRIORITIES.find((item) => item.key === priority)?.weight ?? 2;
}

export function statusDot(status: Status): string {
  return STATUSES.find((item) => item.key === status)?.dot ?? 'var(--text-dim)';
}

export function priorityDot(priority: Priority): string {
  return PRIORITIES.find((item) => item.key === priority)?.dot ?? 'var(--amber)';
}

/** The email of a person, or their id when the directory gave none (rendered as text). */
export function personLabel(person: Person): string {
  return person.email ?? person.user_id;
}

export interface Filters {
  status: ReadonlySet<Status>;
  priority: ReadonlySet<Priority>;
  /** An agent id, or 'all'. */
  agent: string;
  /** 'all', 'none' (unassigned) or 'me'. */
  assignee: 'all' | 'none' | 'me';
}

export const NO_FILTERS: Filters = {
  status: new Set(),
  priority: new Set(),
  agent: 'all',
  assignee: 'all',
};

export function filterCount(filters: Filters): number {
  return (
    filters.status.size +
    filters.priority.size +
    (filters.agent === 'all' ? 0 : 1) +
    (filters.assignee === 'all' ? 0 : 1)
  );
}

/** Design QUICK: the quick views (as the API's `view`). */
export function inQuickView(view: QuickView, ticket: Ticket, userId: string): boolean {
  if (view === 'mine') return ticket.assignee?.user_id === userId;
  if (view === 'unassigned') return ticket.assignee === null;
  if (view === 'high') return ticket.priority === 'high' && ticket.status !== 'done';
  return true;
}

/** Search by title or id (the short one people read, or the whole one of a link). */
export function matchesQuery(ticket: Ticket, query: string): boolean {
  const q = query.trim().toLocaleLowerCase('es');
  if (!q) return true;
  return ticket.title.toLocaleLowerCase('es').includes(q) || ticket.ticket_id.includes(q);
}

export function matchesFilters(ticket: Ticket, filters: Filters, userId: string): boolean {
  if (filters.status.size && !filters.status.has(ticket.status)) return false;
  if (filters.priority.size && !filters.priority.has(ticket.priority)) return false;
  if (filters.agent !== 'all' && ticket.agent_id !== filters.agent) return false;
  if (filters.assignee === 'none' && ticket.assignee !== null) return false;
  if (filters.assignee === 'me' && ticket.assignee?.user_id !== userId) return false;
  return true;
}

export interface Listed {
  /** The tickets of the quick view, with the search and the filters. */
  shown: Ticket[];
  /** Of each quick view, over the tickets that match the search and the filters. */
  counts: Record<QuickView, number>;
}

export function listed(
  tickets: readonly Ticket[],
  query: string,
  filters: Filters,
  view: QuickView,
  userId: string,
): Listed {
  const base = tickets.filter(
    (ticket) => matchesQuery(ticket, query) && matchesFilters(ticket, filters, userId),
  );
  const counts = { all: 0, mine: 0, unassigned: 0, high: 0 };
  for (const ticket of base) {
    for (const quick of QUICK_VIEWS) if (inQuickView(quick, ticket, userId)) counts[quick] += 1;
  }
  return { shown: base.filter((ticket) => inQuickView(view, ticket, userId)), counts };
}

/** Design Kanban: higher priority first, then the newest. */
export function boardOrder(a: Ticket, b: Ticket): number {
  return (
    priorityWeight(b.priority) - priorityWeight(a.priority) ||
    b.created_at.localeCompare(a.created_at)
  );
}

export type SortKey = 'id' | 'title' | 'agent' | 'status' | 'prio' | 'age' | 'assignee';
export interface Sort {
  key: SortKey;
  /** 1 ascending, -1 descending (design `sort.dir`). */
  dir: 1 | -1;
}

export const DEFAULT_SORT: Sort = { key: 'age', dir: 1 };

function sortValue(ticket: Ticket, key: SortKey): string | number {
  switch (key) {
    case 'id':
      return shortId(ticket.ticket_id);
    case 'title':
      return ticket.title.toLocaleLowerCase('es');
    case 'agent':
      return (ticket.agent_name ?? '').toLocaleLowerCase('es');
    case 'status':
      return STATUSES.findIndex((item) => item.key === ticket.status);
    case 'prio':
      return -priorityWeight(ticket.priority);
    case 'age':
      // Design: ascending age is the newest first.
      return -Date.parse(ticket.created_at) || 0;
    case 'assignee':
      return ticket.assignee ? personLabel(ticket.assignee) : '￿';
  }
}

export function sorted(tickets: readonly Ticket[], sort: Sort): Ticket[] {
  return tickets.toSorted((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    return (x > y ? 1 : x < y ? -1 : 0) * sort.dir;
  });
}

/**
 * Where a ticket may go by hand. «Por aprobar» is never a target (the API answers 422); a ticket
 * «Por aprobar» only leaves it as «Resuelto»: the API keeps showing it «Por aprobar» after any
 * other change while the request stays open (decided on 2026-11-05 by the lead agent).
 */
export function canMoveTo(ticket: Pick<Ticket, 'status'>, target: Status): boolean {
  if (target === 'needs_approval' || target === ticket.status) return false;
  return ticket.status !== 'needs_approval' || target === 'done';
}

/** Who a ticket may be assigned to (D112): the person, then whoever already takes part. */
export function assignable(detail: TicketDetail, userId: string): Person[] {
  const me = detail.participants.find((person) => person.user_id === userId) ?? {
    user_id: userId,
    email: null,
  };
  return [me, ...detail.participants.filter((person) => person.user_id !== userId)];
}

/** The agent of a ticket can no longer be used by the person (it is not among theirs). */
export function agentLost(
  ticket: Pick<Ticket, 'agent_id'>,
  usable: ReadonlySet<string> | null,
): boolean {
  return ticket.agent_id !== null && usable !== null && !usable.has(ticket.agent_id);
}

export type ActivityLine =
  | { kind: 'created'; source: Ticket['source']; actor: Person; agent: string | null; at: string }
  | { kind: 'assigned'; who: Person }
  | { kind: 'approval' }
  | {
      kind: 'changed';
      actor: Person;
      field: 'status' | 'priority' | 'assignee';
      after: string | null;
      at: string;
    };

/**
 * Design «Actividad»: how it was created, who was left in charge, «Por aprobar» and each change
 * (comments are in their own tab). From the history the API keeps, not from the list.
 */
export function activity(detail: TicketDetail): ActivityLine[] {
  const created = detail.history.find((event) => event.action === 'created');
  const lines: ActivityLine[] = [
    {
      kind: 'created',
      source: detail.source,
      actor: created?.actor ?? detail.creator,
      agent: detail.agent_name,
      at: created?.created_at ?? detail.created_at,
    },
  ];
  const changes = detail.history.filter(
    (event): event is TicketEvent & { field: NonNullable<TicketEvent['field']> } =>
      event.action === 'changed' && event.field !== null,
  );
  // Assigned when it was created: no change says so.
  if (detail.assignee && !changes.some((event) => event.field === 'assignee')) {
    lines.push({ kind: 'assigned', who: detail.assignee });
  }
  if (detail.status === 'needs_approval') lines.push({ kind: 'approval' });
  for (const event of changes) {
    lines.push({
      kind: 'changed',
      actor: event.actor,
      field: event.field,
      after: event.after,
      at: event.created_at,
    });
  }
  return lines;
}

/** The fields of a list item, from a detail the API answered (after a change). */
export function summaryOf(detail: TicketDetail): Ticket {
  return {
    ticket_id: detail.ticket_id,
    title: detail.title,
    status: detail.status,
    priority: detail.priority,
    agent_id: detail.agent_id,
    agent_name: detail.agent_name,
    creator: detail.creator,
    assignee: detail.assignee,
    source: detail.source,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    version: detail.version,
    comment_count: detail.comment_count,
    approval_id: detail.approval_id,
  };
}

/** The list with one ticket replaced (or added first when it is new). */
export function withTicket(tickets: readonly Ticket[], ticket: Ticket): Ticket[] {
  const index = tickets.findIndex((item) => item.ticket_id === ticket.ticket_id);
  if (index === -1) return [ticket, ...tickets];
  return tickets.map((item, i) => (i === index ? ticket : item));
}

export type ErrorKey =
  | 'tickets.error.changed'
  | 'tickets.error.secret'
  | 'tickets.error.notParticipant'
  | 'tickets.error.commentLimit'
  | 'tickets.error.agentUnavailable'
  | 'tickets.error.gone'
  | 'tickets.error.rateLimited'
  | 'tickets.error.generic';

/** The text of a change the API refused (i18n key of `tickets.error`). */
export function errorKey(error: unknown): ErrorKey {
  const { status, code }: { status: unknown; code: unknown } =
    typeof error === 'object' && error !== null && 'status' in error && 'code' in error
      ? error
      : { status: 0, code: '' };
  if (status === 409 && code === 'ticket_changed') return 'tickets.error.changed';
  if (code === 'secret_in_ticket') return 'tickets.error.secret';
  if (code === 'assignee_not_participant') return 'tickets.error.notParticipant';
  if (code === 'ticket_comment_limit') return 'tickets.error.commentLimit';
  if (code === 'agent_unavailable') return 'tickets.error.agentUnavailable';
  if (status === 404 || status === 403) return 'tickets.error.gone';
  if (status === 429) return 'tickets.error.rateLimited';
  return 'tickets.error.generic';
}
