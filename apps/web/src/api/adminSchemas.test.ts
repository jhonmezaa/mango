import { describe, expect, it, vi } from 'vitest';

import {
  budgetsSchema,
  businessUnitsSchema,
  connectivitySchema,
  organizationSchema,
  parseMoney,
} from './adminSchemas';
import { createApiClient } from './client';
import { ApiError } from './errors';
import { ORGANIZATION, budgetsFixture, businessUnitsFixture } from '../test/adminFixtures';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function client(fetchImpl: typeof fetch) {
  return createApiClient({
    basePath: '/api',
    getAccessToken: () => Promise.resolve('token'),
    fetchImpl,
  });
}

describe('admin schemas', () => {
  it('accept the contract shapes', () => {
    expect(budgetsSchema.safeParse(budgetsFixture()).success).toBe(true);
    expect(businessUnitsSchema.safeParse(businessUnitsFixture()).success).toBe(true);
    expect(organizationSchema.safeParse(ORGANIZATION).success).toBe(true);
    expect(
      connectivitySchema.safeParse({
        checked_at: '2026-09-29T10:00:00Z',
        checks: [{ name: 'broker', status: 'ok', detail: 'ok' }],
      }).success,
    ).toBe(true);
  });

  it('reject malformed amounts, areas, OU IDs and unknown checks', () => {
    expect(
      budgetsSchema.safeParse(
        budgetsFixture({ defaults: { user_monthly_usd: '1e9', agent_monthly_usd: '10' } }),
      ).success,
    ).toBe(false);
    expect(
      businessUnitsSchema.safeParse({ version: 1, units: { 'Área Mayúscula': [] }, pending: [] })
        .success,
    ).toBe(false);
    expect(
      businessUnitsSchema.safeParse({ version: 1, units: { retail: ['ou-<x>'] }, pending: [] })
        .success,
    ).toBe(false);
    expect(
      connectivitySchema.safeParse({
        checked_at: 'x',
        checks: [{ name: 'shell', status: 'ok', detail: '' }],
      }).success,
    ).toBe(false);
  });

  it('accepts the area "constructor" as an own key and rejects other prototype names', () => {
    const parsed = businessUnitsSchema.parse(
      JSON.parse('{"version":1,"units":{"constructor":["ou-a1b2-22222222"]},"pending":[]}'),
    );
    expect(Object.hasOwn(parsed.units, 'constructor')).toBe(true);
    expect(parsed.units.constructor).toEqual(['ou-a1b2-22222222']);
    for (const key of ['__proto__', 'toString', 'hasOwnProperty']) {
      const raw = JSON.parse(`{"version":1,"units":{"${key}":[]},"pending":[]}`) as unknown;
      expect(businessUnitsSchema.safeParse(raw).success).toBe(false);
    }
    expect(({} as Record<string, unknown>).length).toBeUndefined();
  });

  it('parses admin-typed USD amounts like the design (comma decimals, dot thousands)', () => {
    expect(parseMoney('150')).toEqual({ value: '150.00' });
    expect(parseMoney(' 150,5 ')).toEqual({ value: '150.50' });
    expect(parseMoney('1.250,00')).toEqual({ value: '1250.00' });
    expect(parseMoney('USD 1200.25')).toEqual({ value: '1200.25' });
    expect(parseMoney('1000000')).toEqual({ value: '1000000.00' });
    expect(parseMoney('')).toEqual({ error: 'gov.money.empty' });
    expect(parseMoney('abc')).toEqual({ error: 'gov.money.format' });
    expect(parseMoney('-1')).toEqual({ error: 'gov.money.format' });
    expect(parseMoney('1e3')).toEqual({ error: 'gov.money.format' });
    expect(parseMoney('12.345')).toEqual({ error: 'gov.money.decimals' });
    expect(parseMoney('0,00')).toEqual({ error: 'gov.money.positive' });
    expect(parseMoney('1000000,01')).toEqual({ error: 'gov.money.max' });
  });
});

describe('admin client', () => {
  it('encodes the user ID and sends only the contract fields', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(budgetsFixture())));
    await client(fetchMock).putUserBudget('user+1@example.com', { version: 4, limit_usd: null });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/admin/budgets/users/user%2B1%40example.com');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ version: 4, limit_usd: null });
  });

  it('refuses path traversal in user and change IDs before any request', () => {
    const fetchMock = vi.fn<typeof fetch>();
    const api = client(fetchMock);
    expect(() => api.putUserBudget('../admin', { version: 1, limit_usd: null })).toThrow();
    expect(() => api.approveBusinessUnitChange('a/../b')).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a reason to propose or reject', () => {
    const fetchMock = vi.fn<typeof fetch>();
    const api = client(fetchMock);
    expect(() => api.rejectBusinessUnitChange('CHG', '   ')).toThrow(ApiError);
    expect(() =>
      api.proposeBusinessUnits({ base_version: 1, units: {}, reason: 'x'.repeat(501) }),
    ).toThrow(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces admin error codes as ApiError', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ error: { code: 'same_approver', message: 'x' } }, 403)),
    );
    await expect(client(fetchMock).approveBusinessUnitChange('CHG')).rejects.toMatchObject({
      status: 403,
      code: 'same_approver',
    });
  });
});
