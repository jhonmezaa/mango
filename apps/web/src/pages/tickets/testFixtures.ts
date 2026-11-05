import { baseMe } from '../../test/fixtures';
import type { Ticket, TicketDetail } from './model';

export const ME = baseMe.user_id;
export const OTHER = 'b1b2c3d4-0000-4000-8000-0000000000bb';
export const THIRD = 'c1b2c3d4-0000-4000-8000-0000000000cc';

export const person = (userId: string, email: string | null = null) => ({
  user_id: userId,
  email: email ?? (userId === ME ? (baseMe.email ?? null) : `${userId.slice(0, 4)}@example.com`),
});

let next = 0;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A valid ticket id (12 base32 characters), different on each call, also in its first eight. */
export function ticketId(): string {
  next += 1;
  let n = next;
  let head = '';
  for (let i = 0; i < 4; i += 1) {
    head += B32[n % 32] ?? 'a';
    n = Math.floor(n / 32);
  }
  return `${head}tkmock22`;
}

export function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    ticket_id: ticketId(),
    title: 'Revisar el costo de prod-web',
    status: 'open',
    priority: 'medium',
    agent_id: null,
    agent_name: null,
    creator: person(ME),
    assignee: null,
    source: 'web',
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    updated_at: new Date(Date.now() - 3_600_000).toISOString(),
    version: 1,
    comment_count: 0,
    approval_id: null,
    ...overrides,
  };
}

export function detail(overrides: Partial<TicketDetail> = {}): TicketDetail {
  const base = ticket(overrides);
  return {
    ...base,
    description: '',
    comments: [],
    history: [
      {
        actor: base.creator,
        action: 'created',
        field: null,
        before: null,
        after: null,
        created_at: base.created_at,
      },
    ],
    participants: [base.creator, ...(base.assignee ? [base.assignee] : [])],
    ...overrides,
  };
}
