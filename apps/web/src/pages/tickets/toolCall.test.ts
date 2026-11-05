import { describe, expect, it } from 'vitest';

import { ticketCall } from './toolCall';

const ID = 'abcdefgh2345';

describe('ticketCall', () => {
  it('reads a ticket creation from the stored title', () => {
    expect(
      ticketCall({ tool: 'mango-tickets.create_ticket', arguments: { title: '  Revisar  ' } }),
    ).toEqual({ op: 'create', title: 'Revisar' });
  });

  it('reads the changes of an update', () => {
    expect(
      ticketCall({
        tool: 'mango-tickets.update_ticket',
        arguments: { ticket_id: ID, status: 'in_progress', priority: 'high', assign_to_me: true },
      }),
    ).toEqual({
      op: 'update',
      ticketId: ID,
      changes: [
        { field: 'status', value: 'in_progress' },
        { field: 'priority', value: 'high' },
        { field: 'assignee' },
      ],
    });
  });

  it('ignores values that are not the tool’s', () => {
    expect(
      ticketCall({
        tool: 'mango-tickets.update_ticket',
        arguments: { ticket_id: ID, status: 'needs_approval', priority: '<b>x</b>' },
      }),
    ).toEqual({ op: 'update', ticketId: ID, changes: [] });
  });

  it('reads a comment by its ticket', () => {
    expect(
      ticketCall({
        tool: 'mango-tickets.comment_ticket',
        arguments: { ticket_id: ID, body: 'hola' },
      }),
    ).toEqual({ op: 'comment', ticketId: ID });
  });

  it('leaves every other tool, and malformed calls, as they are', () => {
    expect(ticketCall({ tool: 'aws-budgets.create_budget', arguments: {} })).toBeNull();
    expect(ticketCall({ tool: 'mango-tickets.create_ticket', arguments: {} })).toBeNull();
    expect(
      ticketCall({ tool: 'mango-tickets.comment_ticket', arguments: { ticket_id: '../x' } }),
    ).toBeNull();
    expect(
      ticketCall({ tool: 'mango-tickets.delete_ticket', arguments: { ticket_id: ID } }),
    ).toBeNull();
  });
});
