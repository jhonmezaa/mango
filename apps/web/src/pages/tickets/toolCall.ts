import { parseTicketId, type ChosenStatus, type Priority } from './model';

// The tickets tool of the Gateway (connectors/mango-tickets, D112 (8)): what the confirmation
// card of the chat says it writes. It is read from the tool and the arguments the API stored for
// the request (never from the model's text, R3); anything that does not look like a call of
// this tool leaves the card as it is for every other write tool.

const SERVER = 'mango-tickets';
const STATUSES: ReadonlySet<string> = new Set<ChosenStatus>(['open', 'in_progress', 'done']);
const PRIORITIES: ReadonlySet<string> = new Set<Priority>(['high', 'medium', 'low']);

export type TicketChange =
  | { field: 'status'; value: ChosenStatus }
  | { field: 'priority'; value: Priority }
  | { field: 'assignee' };

export type TicketCall =
  | { op: 'create'; title: string }
  | { op: 'update'; ticketId: string; changes: TicketChange[] }
  | { op: 'comment'; ticketId: string };

export function ticketCall(call: {
  tool: string;
  arguments: Record<string, unknown>;
}): TicketCall | null {
  const [server, name] = call.tool.split('.', 2);
  if (server !== SERVER) return null;
  const args = call.arguments;
  if (name === 'create_ticket') {
    return typeof args.title === 'string' && args.title.trim()
      ? { op: 'create', title: args.title.trim() }
      : null;
  }
  const ticketId = parseTicketId(args.ticket_id);
  if (ticketId === null) return null;
  if (name === 'comment_ticket') return { op: 'comment', ticketId };
  if (name !== 'update_ticket') return null;
  const changes: TicketChange[] = [];
  if (typeof args.status === 'string' && STATUSES.has(args.status)) {
    changes.push({ field: 'status', value: args.status as ChosenStatus });
  }
  if (typeof args.priority === 'string' && PRIORITIES.has(args.priority)) {
    changes.push({ field: 'priority', value: args.priority as Priority });
  }
  if (args.assign_to_me === true) changes.push({ field: 'assignee' });
  return { op: 'update', ticketId, changes };
}
