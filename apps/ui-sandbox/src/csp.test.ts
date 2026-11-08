import { describe, expect, it } from 'vitest';

import { comparePolicies, innerCsp, innerPolicy, normalizeDomains } from './csp';

const ORIGIN = 'https://d123.cloudfront.net';

/** The directives of a policy, by name. */
function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

// The ceiling of the outer document (infra/lib/constructs/ui-sandbox-origin.ts, UI_SANDBOX_CSP).
const CEILING = directives(
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
);

describe('the inner frame policy', () => {
  const csp = directives(innerCsp(ORIGIN, innerPolicy()));

  it('only reaches the mirror of its own origin', () => {
    expect(csp.get('default-src')).toEqual(["'none'"]);
    expect(csp.get('connect-src')).toEqual([`${ORIGIN}/vendor/`]);
    expect(csp.get('script-src')).toContain(`${ORIGIN}/vendor/`);
    expect(csp.get('img-src')).toEqual(['data:', 'blob:']);
    for (const name of ['frame-src', 'object-src', 'base-uri', 'form-action', 'media-src']) {
      expect(csp.get(name)).toEqual(["'none'"]);
    }
  });

  it('is never looser than the ceiling it is added to', () => {
    // Each source of the inner policy is a keyword the ceiling has, or a path of 'self'.
    for (const [name, values] of csp) {
      const ceiling = CEILING.get(name) ?? CEILING.get('default-src') ?? [];
      for (const value of values) {
        const allowed =
          value === "'none'" ||
          ceiling.includes(value) ||
          (value.startsWith(`${ORIGIN}/`) && ceiling.includes("'self'"));
        expect(allowed, `${name} ${value}`).toBe(true);
      }
    }
  });

  it('has no character that could end a directive inside a domain', () => {
    expect(() => normalizeDomains(['evil.com; script-src *'])).toThrow();
    expect(() => normalizeDomains(['"evil.com"'])).toThrow();
    expect(() => normalizeDomains(['evil.com,other.com'])).toThrow();
  });
});

describe('normalizeDomains', () => {
  it('keeps only origins, https by default, sorted and unique', () => {
    expect(
      normalizeDomains([
        ' api.example.com ',
        'https://api.example.com/path?q=1',
        'wss://ws.example.com',
      ]),
    ).toEqual(['https://api.example.com', 'wss://ws.example.com']);
  });

  it.each([
    'http://example.com',
    'https://user:pw@example.com',
    'https://*.example.com',
    'data:x',
    'blob:x',
  ])('refuses %s', (value) => {
    expect(() => normalizeDomains([value])).toThrow();
  });
});

describe('innerPolicy (within the ceiling)', () => {
  it('refuses any domain while the ceiling has none (until A1)', () => {
    expect(() => innerPolicy(['api.example.com'])).toThrow(/outside the ceiling/);
  });

  it('takes the domains the ceiling names', () => {
    expect(innerPolicy(['api.example.com'], ['https://api.example.com']).connectDomains).toEqual([
      'https://api.example.com',
    ]);
  });
});

describe('comparePolicies (a policy only gets stricter)', () => {
  const a = { connectDomains: ['https://a.example.com', 'https://b.example.com'] };
  it('equal, stricter and looser', () => {
    expect(comparePolicies(a, { connectDomains: [...a.connectDomains] })).toBe('equal');
    expect(comparePolicies(a, { connectDomains: ['https://a.example.com'] })).toBe('stricter');
    expect(comparePolicies(a, { connectDomains: [] })).toBe('stricter');
    expect(comparePolicies(a, { connectDomains: ['https://c.example.com'] })).toBe('looser');
    expect(comparePolicies({ connectDomains: [] }, a)).toBe('looser');
  });
});
