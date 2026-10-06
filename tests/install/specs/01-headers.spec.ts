import { expect, test } from '../src/fixtures.ts';

// Security headers of the edge, without a session. Leaves nothing in the installation.

/** `default-src 'self'; script-src 'self'` → `{ 'default-src': ["'self'"], … }`. */
function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((words) => words[0])
      .map(([name, ...values]) => [name ?? '', values]),
  );
}

test('the page comes with the security headers', async ({ request }) => {
  const response = await request.get('/');
  expect(response.status()).toBe(200);
  const headers = response.headers();
  const csp = directives(headers['content-security-policy'] ?? '');
  expect(csp['default-src']).toEqual(["'self'"]);
  // No inline or evaluated code, from nowhere but the installation.
  expect(csp['script-src']).toEqual(["'self'"]);
  expect(csp['style-src']).toEqual(["'self'"]);
  expect(csp['frame-ancestors']).toEqual(["'none'"]);
  expect(csp['object-src']).toEqual(["'none'"]);
  expect(csp['base-uri']).toEqual(["'none'"]);
  for (const source of csp['connect-src'] ?? []) {
    expect(source === "'self'" || source.startsWith('https://')).toBe(true);
  }
  expect(headers['strict-transport-security']).toMatch(/max-age=\d{7,}/);
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['permissions-policy']).toBeTruthy();
  // The entry page is never served from a cache: an update shows up on the next load.
  expect(headers['cache-control']).toContain('no-store');
});

test('the API answers, carries the headers too and refuses a call without a session', async ({
  request,
}) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  expect(health.headers()['x-content-type-options']).toBe('nosniff');
  expect(health.headers()['strict-transport-security']).toMatch(/max-age=\d{7,}/);

  const me = await request.get('/api/me');
  expect(me.status()).toBe(401);
  const admin = await request.get('/api/admin/installation');
  expect(admin.status()).toBe(401);
});

test('the public configuration of the SPA holds no secret and MFA is required', async ({
  request,
}) => {
  const response = await request.get('/config.json');
  expect(response.status()).toBe(200);
  const text = await response.text();
  expect(text).not.toMatch(/secret|password|eyJ/i);
  const config = JSON.parse(text) as { auth?: { mfa?: string; sessionHours?: number } };
  expect(config.auth?.mfa).toBe('required');
  expect(config.auth?.sessionHours).toBeGreaterThan(0);
});
