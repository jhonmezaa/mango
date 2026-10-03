import { describe, expect, it } from 'vitest';

import { selfApproval } from '../pages/approvals/testFixtures';
import { parseChatEvent } from './chatEvents';

describe('parseChatEvent', () => {
  it('maps every contract event to a typed event', () => {
    expect(parseChatEvent({ event: 'conversation', data: '{"conversation_id":"01JABC"}' })).toEqual(
      {
        type: 'conversation',
        conversation_id: '01JABC',
      },
    );
    expect(
      parseChatEvent({ event: 'tool', data: '{"name":"get_cost_and_usage","status":"started"}' }),
    ).toEqual({ type: 'tool', name: 'get_cost_and_usage', status: 'started' });
    expect(parseChatEvent({ event: 'delta', data: '{"text":"| a |"}' })).toEqual({
      type: 'delta',
      text: '| a |',
    });
    expect(
      parseChatEvent({
        event: 'done',
        data: '{"message_id":"01J","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":2},"cost_usd":"0.01"}',
      }),
    ).toMatchObject({
      type: 'done',
      cost_usd: '0.01',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(
      parseChatEvent({ event: 'error', data: '{"code":"budget_exceeded","message":"x"}' }),
    ).toEqual({ type: 'error', code: 'budget_exceeded', message: 'x' });
  });

  it('maps the live progress of the turn', () => {
    expect(
      parseChatEvent({ event: 'status', data: '{"phase":"tool","tool":"get_cost_and_usage"}' }),
    ).toEqual({ type: 'status', phase: 'tool', tool: 'get_cost_and_usage' });
    expect(parseChatEvent({ event: 'status', data: '{"phase":"thinking"}' })).toEqual({
      type: 'status',
      phase: 'thinking',
    });
    // A phase added by a newer API is still a valid event (the reducer falls back to thinking).
    expect(parseChatEvent({ event: 'status', data: '{"phase":"planning"}' })).toEqual({
      type: 'status',
      phase: 'planning',
    });
    expect(parseChatEvent({ event: 'status', data: '{"tool":"x"}' })).toMatchObject({
      type: 'error',
      code: 'invalid_event',
    });
  });

  it('ignores unknown event types (forward compatible)', () => {
    expect(parseChatEvent({ event: 'citation', data: '{}' })).toBeNull();
    expect(parseChatEvent({ event: 'toString', data: '{}' })).toBeNull();
  });

  it('turns malformed payloads into a client error event', () => {
    expect(parseChatEvent({ event: 'delta', data: 'not json' })).toMatchObject({
      type: 'error',
      code: 'invalid_event',
    });
    expect(parseChatEvent({ event: 'tool', data: '{"name":"x","status":"weird"}' })).toMatchObject({
      type: 'error',
    });
    expect(
      parseChatEvent({ event: 'conversation', data: '{"conversation_id":"../../admin"}' }),
    ).toMatchObject({ type: 'error' });
  });

  it('reads an approval request and rejects one that does not fit the contract', () => {
    const request = selfApproval();
    expect(parseChatEvent({ event: 'approval', data: JSON.stringify(request) })).toEqual({
      type: 'approval',
      approval: request,
    });
    expect(
      parseChatEvent({ event: 'approval', data: JSON.stringify({ ...request, status: 'weird' }) }),
    ).toEqual({ type: 'error', code: 'invalid_event', message: 'Malformed stream event' });
  });
});
