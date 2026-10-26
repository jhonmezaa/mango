import { describe, expect, it } from 'vitest';

import { parsePlaygroundEvent } from './playgroundEvents';

const DONE =
  '{"stop_reason":"end_turn","usage":{"input_tokens":1234,"output_tokens":321},"cost_usd":"0.0123","duration_ms":2100,"flags":{"guardrail":true,"token_cap":false,"time_limit":false,"iteration_limit":true}}';

describe('parsePlaygroundEvent', () => {
  it('maps the events of the contract', () => {
    expect(parsePlaygroundEvent({ event: 'delta', data: '{"text":"<b>x</b>"}' })).toEqual({
      type: 'delta',
      text: '<b>x</b>',
    });
    expect(parsePlaygroundEvent({ event: 'simulated_write', data: '{"tool":"stop"}' })).toEqual({
      type: 'simulated_write',
      tool: 'stop',
    });
    expect(parsePlaygroundEvent({ event: 'done', data: DONE })).toMatchObject({
      type: 'done',
      duration_ms: 2100,
      flags: { guardrail: true, iteration_limit: true },
    });
  });

  it('keeps whose budget ran out and drops the server message', () => {
    expect(
      parsePlaygroundEvent({ event: 'error', data: '{"code":"budget_exceeded","scope":"agent"}' }),
    ).toEqual({ type: 'error', code: 'budget_exceeded', scope: 'agent' });
    expect(
      parsePlaygroundEvent({ event: 'error', data: '{"code":"upstream_error","message":"raw"}' }),
    ).toEqual({ type: 'error', code: 'upstream_error' });
  });

  it('ignores unknown events and turns a bad payload into an error', () => {
    expect(parsePlaygroundEvent({ event: 'approval', data: '{}' })).toBeNull();
    expect(parsePlaygroundEvent({ event: 'done', data: '{"cost_usd":"1e9"}' })).toEqual({
      type: 'error',
      code: 'invalid_event',
    });
    expect(parsePlaygroundEvent({ event: 'tool', data: 'not json' })).toEqual({
      type: 'error',
      code: 'invalid_event',
    });
  });
});
