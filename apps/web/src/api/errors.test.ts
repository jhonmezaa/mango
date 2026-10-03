import { describe, expect, it } from 'vitest';

import { ApiError, apiErrorFromResponse } from './errors';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

describe('apiErrorFromResponse', () => {
  it('keeps the rules of a 422 validation_failed', async () => {
    const error = await apiErrorFromResponse(
      json(422, {
        error: { code: 'validation_failed', message: 'the version does not meet the review rules' },
        violations: [
          { code: 'reports_to_cycle', field: 'reports_to', items: ['finops'] },
          { code: 'secret_detected', field: 'system_prompt', items: ['aws_access_key_id'] },
        ],
      }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect([error.status, error.code]).toEqual([422, 'validation_failed']);
    expect(error.violations).toEqual([
      { code: 'reports_to_cycle', field: 'reports_to', items: ['finops'] },
      { code: 'secret_detected', field: 'system_prompt', items: ['aws_access_key_id'] },
    ]);
  });

  it('has no rules for other errors', async () => {
    const error = await apiErrorFromResponse(
      json(409, { error: { code: 'version_conflict', message: 'x' } }),
    );
    expect([error.code, error.violations]).toEqual(['version_conflict', null]);
  });

  it('does not trust a body whose rules are malformed', async () => {
    const error = await apiErrorFromResponse(
      json(422, {
        error: { code: 'validation_failed', message: 'x' },
        violations: [{ code: 'x', field: 'y', items: 'not-a-list' }],
      }),
    );
    // The body no longer matches the contract: a generic error, without its content.
    expect([error.status, error.code, error.violations]).toEqual([422, 'http_422', null]);
  });

  it('reads Retry-After of a 429 and tolerates a body that is not JSON', async () => {
    const limited = await apiErrorFromResponse(
      json(429, { error: { code: 'submission_limit', message: 'x' } }, { 'Retry-After': '120' }),
    );
    expect([limited.code, limited.retryAfter]).toEqual(['submission_limit', 120]);
    const proxy = await apiErrorFromResponse(new Response('<html>', { status: 502 }));
    expect([proxy.status, proxy.code, proxy.violations]).toEqual([502, 'http_502', null]);
  });
});
