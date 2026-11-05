/**
 * Mock routes of Tickets (D112): GET/POST /tickets, GET/PATCH /tickets/{id} and POST
 * /tickets/{id}/comments, in the generated contract, with the rules of `mango_api.tickets` the
 * screen depends on: ids of 12 base32 characters, the version that was read (409), «Por aprobar»
 * derived from an open request of the conversation and agent that created the ticket (never
 * chosen: 422), assigning only to oneself or to someone who takes part (422), and the tickets
 * tool of the chat run when the person confirms it. Texts with HTML check that they render as
 * text. The mock user is an administrator: they see every ticket; one titled «mock-gone» answers
 * 404, to see «No puedes ver este ticket».
 */
import { randomBytes } from 'node:crypto';

import { agents, versionOf } from './agents.ts';
import { openRequestsOf, registerExecutor } from './approvals.ts';
import { MOCK_USER } from './cognito.ts';
import { readBody, readObject, sendError, sendJson, type ApiHandler } from './http.ts';

type Status = 'open' | 'in_progress' | 'done';
type Priority = 'high' | 'medium' | 'low';
type Source = 'web' | 'agent' | 'task';

interface MockEvent {
  actor: string;
  action: 'created' | 'changed' | 'commented';
  field: 'status' | 'priority' | 'assignee' | null;
  before: string | null;
  after: string | null;
  created_at: string;
}

interface MockTicket {
  ticket_id: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  agent_id: string | null;
  agent_name: string | null;
  creator: string;
  assignee: string | null;
  source: Source;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  comments: { comment_id: string; author: string; body: string; created_at: string }[];
  history: MockEvent[];
}

const OTHER = 'usuario4@example.com';
const THIRD = 'usuario2@example.com';
const ID = /^[a-z2-7]{12}$/;
const STATUSES = new Set(['open', 'in_progress', 'done']);
const PRIORITIES = new Set(['high', 'medium', 'low']);
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const HOUR_MS = 3_600_000;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 8000;
const MAX_COMMENT = 4000;
const SECRET = /AKIA[0-9A-Z]{16}/;

/** A string field of a body, or '' (bodies are untrusted). */
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const iso = (hoursAgo = 0) => new Date(Date.now() - hoursAgo * HOUR_MS).toISOString();
const newTicketId = () => [...randomBytes(12)].map((byte) => B32[byte % 32] ?? 'a').join('');
const newId = () => randomBytes(16).toString('hex');

const tickets = new Map<string, MockTicket>();

function agentName(agentId: string): string {
  const agent = agents.get(agentId);
  return (agent && versionOf(agent, agent.published_version)?.definition.name) ?? agentId;
}

function add(seed: Partial<MockTicket> & Pick<MockTicket, 'title' | 'creator'>): MockTicket {
  const created = seed.created_at ?? iso(1);
  const ticket: MockTicket = {
    ticket_id: newTicketId(),
    description: '',
    status: 'open',
    priority: 'medium',
    agent_id: null,
    agent_name: null,
    assignee: null,
    source: 'web',
    conversation_id: null,
    created_at: created,
    updated_at: created,
    version: 1,
    comments: [],
    history: [],
    ...seed,
  };
  ticket.history = [
    {
      actor: ticket.creator,
      action: 'created',
      field: null,
      before: null,
      after: null,
      created_at: created,
    },
    ...ticket.history,
  ];
  tickets.set(ticket.ticket_id, ticket);
  return ticket;
}

function seed(): void {
  add({
    title: 'Revisar el aumento de costo de Bedrock en prod-web',
    description: 'El gasto de la semana subió un 38 %. Ver el desglose por modelo.',
    priority: 'high',
    agent_id: 'finops',
    agent_name: 'FinOps',
    source: 'agent',
    conversation_id: newId(),
    creator: MOCK_USER,
    created_at: iso(3),
    comments: [
      {
        comment_id: newId(),
        author: OTHER,
        body: 'Lo miro mañana. **Primero** el modelo grande:\n\n- prod-web\n- prod-api\n\n<img src=x onerror=alert(1)>',
        created_at: iso(2),
      },
    ],
  });
  // «Por aprobar»: an open request of the conversation where FinOps created it.
  const open = openRequestsOf(OTHER)[0];
  add({
    title: 'Crear el presupuesto de plataforma-q4',
    status: 'in_progress',
    priority: 'medium',
    agent_id: 'finops',
    agent_name: 'FinOps',
    source: 'agent',
    conversation_id: open?.conversation_id ?? newId(),
    creator: OTHER,
    assignee: MOCK_USER,
    created_at: iso(5),
  });
  add({
    title: 'Resumen semanal de gasto · 2 nov',
    description: 'Gasto de la semana: **USD 1.240**. Sin anomalías.',
    status: 'done',
    priority: 'low',
    agent_id: 'finops',
    agent_name: 'FinOps',
    source: 'task',
    creator: MOCK_USER,
    created_at: iso(30),
  });
  add({
    title: 'Ticket con <b>HTML</b> en el título',
    description: '<script>alert(1)</script> se muestra como texto.',
    priority: 'low',
    creator: THIRD,
    created_at: iso(8),
  });
  add({
    title: 'Reporte mensual de octubre sin enviar',
    agent_id: 'h5cu4n6sl2we7ygt',
    agent_name: 'Reportes mensuales',
    source: 'agent',
    conversation_id: newId(),
    creator: MOCK_USER,
    created_at: iso(48),
  });
  add({ title: 'mock-gone', creator: THIRD, created_at: iso(70) });
}
seed();

function pendingApproval(ticket: MockTicket): string | null {
  if (!ticket.conversation_id || !ticket.agent_id || ticket.status === 'done') return null;
  return (
    openRequestsOf(ticket.creator).find(
      (item) =>
        item.conversation_id === ticket.conversation_id && item.agent_id === ticket.agent_id,
    )?.approval_id ?? null
  );
}

const person = (userId: string) => ({ user_id: userId, email: userId });

function summary(ticket: MockTicket) {
  const approval = pendingApproval(ticket);
  return {
    ticket_id: ticket.ticket_id,
    title: ticket.title,
    status: approval ? 'needs_approval' : ticket.status,
    priority: ticket.priority,
    agent_id: ticket.agent_id,
    agent_name: ticket.agent_name,
    creator: person(ticket.creator),
    assignee: ticket.assignee ? person(ticket.assignee) : null,
    source: ticket.source,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    version: ticket.version,
    comment_count: ticket.comments.length,
    approval_id: approval,
  };
}

function participants(ticket: MockTicket): string[] {
  return [
    ...new Set(
      [ticket.creator, ticket.assignee, ...ticket.comments.map((c) => c.author)].filter(
        (id): id is string => id !== null,
      ),
    ),
  ];
}

function detail(ticket: MockTicket) {
  return {
    ...summary(ticket),
    description: ticket.description,
    comments: ticket.comments.map((comment) => ({
      comment_id: comment.comment_id,
      author: person(comment.author),
      body: comment.body,
      created_at: comment.created_at,
    })),
    history: ticket.history.map((event) => ({ ...event, actor: person(event.actor) })),
    participants: participants(ticket).map(person),
  };
}

function change(
  ticket: MockTicket,
  actor: string,
  field: MockEvent['field'],
  after: string | null,
) {
  const before =
    field === 'status' ? ticket.status : field === 'priority' ? ticket.priority : ticket.assignee;
  if (before === after) return;
  if (field === 'status') ticket.status = after as Status;
  else if (field === 'priority') ticket.priority = after as Priority;
  else ticket.assignee = after;
  ticket.history.push({ actor, action: 'changed', field, before, after, created_at: iso() });
}

function touch(ticket: MockTicket): void {
  ticket.version += 1;
  ticket.updated_at = iso();
}

/** The tickets tool of the chat, once the person confirmed the call (D112 (8)). */
registerExecutor(({ arguments: args, approval_id, tool, conversation_id, agent_id }) => {
  if (tool === 'mango-tickets.create_ticket') {
    add({
      // As the API: the id of the ticket is derived from the approval.
      ticket_id: approval_id
        .slice(0, 12)
        .split('')
        .map((c) => B32[Number.parseInt(c, 16)] ?? 'a')
        .join(''),
      title: str(args.title).slice(0, MAX_TITLE),
      description: str(args.description).slice(0, MAX_DESCRIPTION),
      priority: PRIORITIES.has(str(args.priority)) ? (args.priority as Priority) : 'medium',
      agent_id,
      agent_name: agentName(agent_id),
      source: 'agent',
      conversation_id,
      creator: MOCK_USER,
      created_at: iso(),
    });
    return null;
  }
  const ticket = tickets.get(str(args.ticket_id));
  if (!ticket) return 'ticket_not_found';
  if (tool === 'mango-tickets.comment_ticket') {
    ticket.comments.push({
      comment_id: newId(),
      author: MOCK_USER,
      body: str(args.body),
      created_at: iso(),
    });
  } else {
    if (STATUSES.has(str(args.status))) change(ticket, MOCK_USER, 'status', str(args.status));
    if (PRIORITIES.has(str(args.priority))) {
      change(ticket, MOCK_USER, 'priority', str(args.priority));
    }
    if (args.assign_to_me === true) change(ticket, MOCK_USER, 'assignee', MOCK_USER);
  }
  touch(ticket);
  return null;
});

/** A ticket of the chat demo to write on: the first one the mock user created. */
export function demoTicket(): { ticket_id: string; title: string } | null {
  const ticket = [...tickets.values()].find(
    (item) => item.creator === MOCK_USER && item.title !== 'mock-gone',
  );
  return ticket ? { ticket_id: ticket.ticket_id, title: ticket.title } : null;
}

export const handleTickets: ApiHandler = async (req, res, path) => {
  if (path === '/tickets' && req.method === 'GET') {
    const items = [...tickets.values()]
      .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(summary);
    const counts = {
      all: items.length,
      mine: items.filter((item) => item.assignee?.user_id === MOCK_USER).length,
      unassigned: items.filter((item) => item.assignee === null).length,
      high: items.filter((item) => item.priority === 'high' && item.status !== 'done').length,
    };
    sendJson(res, 200, { items, counts });
    return true;
  }
  if (path === '/tickets' && req.method === 'POST') {
    const body = await readObject(req, [
      'title',
      'description',
      'priority',
      'status',
      'agent_id',
      'assign_to_me',
    ]);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const description = typeof body?.description === 'string' ? body.description : '';
    if (
      !body ||
      !title ||
      title.length > MAX_TITLE ||
      description.length > MAX_DESCRIPTION ||
      !STATUSES.has(str(body.status)) ||
      !PRIORITIES.has(str(body.priority))
    ) {
      sendError(res, 422, 'validation_error', 'invalid ticket');
      return true;
    }
    if (SECRET.test(`${title}\n${description}`)) {
      sendError(res, 422, 'secret_in_ticket', 'the text contains what looks like a credential');
      return true;
    }
    const agentId = typeof body.agent_id === 'string' ? body.agent_id : null;
    const ticket = add({
      title,
      description: description.trim(),
      status: body.status as Status,
      priority: body.priority as Priority,
      agent_id: agentId,
      agent_name: agentId ? agentName(agentId) : null,
      creator: MOCK_USER,
      assignee: body.assign_to_me === true ? MOCK_USER : null,
      created_at: iso(),
    });
    sendJson(res, 201, detail(ticket));
    return true;
  }
  const match = /^\/tickets\/([^/]+)(\/comments)?$/.exec(path);
  if (!match) return false;
  const id = match[1] ?? '';
  const ticket = ID.test(id) ? tickets.get(id) : undefined;
  if (!ticket || ticket.title === 'mock-gone') {
    sendError(res, ID.test(id) ? 404 : 422, 'not_found', 'not found');
    return true;
  }
  if (match[2] && req.method === 'POST') {
    const body = await readObject(req, ['body']);
    const text = typeof body?.body === 'string' ? body.body.trim() : '';
    if (!text || text.length > MAX_COMMENT) {
      sendError(res, 422, 'validation_error', 'invalid comment');
      return true;
    }
    if (SECRET.test(text)) {
      sendError(res, 422, 'secret_in_ticket', 'the text contains what looks like a credential');
      return true;
    }
    ticket.comments.push({ comment_id: newId(), author: MOCK_USER, body: text, created_at: iso() });
    ticket.history.push({
      actor: MOCK_USER,
      action: 'commented',
      field: null,
      before: null,
      after: null,
      created_at: iso(),
    });
    touch(ticket);
    sendJson(res, 201, detail(ticket));
    return true;
  }
  if (match[2]) return false;
  if (req.method === 'GET') {
    sendJson(res, 200, detail(ticket));
    return true;
  }
  if (req.method !== 'PATCH') return false;
  const body = await readChange(req);
  if (!body || typeof body.version !== 'number') {
    sendError(res, 422, 'validation_error', 'invalid change');
    return true;
  }
  if (body.status === 'needs_approval') {
    sendError(res, 422, 'validation_error', '«Por aprobar» is never chosen');
    return true;
  }
  if (
    (body.status !== undefined && !STATUSES.has(str(body.status))) ||
    (body.priority !== undefined && !PRIORITIES.has(str(body.priority)))
  ) {
    sendError(res, 422, 'validation_error', 'invalid change');
    return true;
  }
  if (body.version !== ticket.version) {
    sendError(res, 409, 'ticket_changed', 'the ticket changed; reload it');
    return true;
  }
  if ('assignee_id' in body) {
    const to = body.assignee_id;
    if (
      to !== null &&
      (typeof to !== 'string' || (to !== MOCK_USER && !participants(ticket).includes(to)))
    ) {
      sendError(
        res,
        422,
        'assignee_not_participant',
        'a ticket is assigned to oneself or a participant',
      );
      return true;
    }
  }
  const before = ticket.history.length;
  if (body.status !== undefined) change(ticket, MOCK_USER, 'status', str(body.status));
  if (body.priority !== undefined) change(ticket, MOCK_USER, 'priority', str(body.priority));
  if ('assignee_id' in body) {
    change(
      ticket,
      MOCK_USER,
      'assignee',
      typeof body.assignee_id === 'string' ? body.assignee_id : null,
    );
  }
  if (ticket.history.length !== before) touch(ticket);
  sendJson(res, 200, detail(ticket));
  return true;
};

const CHANGE_KEYS = new Set(['version', 'status', 'priority', 'assignee_id']);

/** A change body: the version and any of its fields, nothing else (extra="forbid"). */
async function readChange(req: Parameters<ApiHandler>[0]): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse((await readBody(req)) || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return Object.keys(parsed).every((key) => CHANGE_KEYS.has(key))
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
