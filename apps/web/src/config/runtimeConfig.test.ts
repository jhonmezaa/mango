import { describe, expect, it, vi } from 'vitest';

import {
  RuntimeConfigError,
  cognitoIdpEndpoint,
  loadRuntimeConfig,
  runtimeConfigSchema,
} from './runtimeConfig';

const valid = {
  region: 'us-east-1',
  cognitoDomain: 'https://mango-dev.auth.us-east-1.amazoncognito.com/',
  userPoolId: 'us-east-1_AbC123',
  clientId: 'abc123def456',
  apiBasePath: '/api/',
  signUpDomains: ['empresa.com'],
  auth: { installationType: 'customer', mfa: 'required', sessionHours: 12 },
};

describe('runtimeConfigSchema', () => {
  it('accepts the contract shape and normalizes trailing slashes', () => {
    expect(runtimeConfigSchema.parse(valid)).toMatchObject({
      cognitoDomain: 'https://mango-dev.auth.us-east-1.amazoncognito.com',
      apiBasePath: '/api',
    });
  });

  it('allows plain http only for localhost', () => {
    expect(
      runtimeConfigSchema.safeParse({ ...valid, cognitoDomain: 'http://localhost:5173/mock' })
        .success,
    ).toBe(true);
    expect(
      runtimeConfigSchema.safeParse({ ...valid, cognitoDomain: 'http://evil.example' }).success,
    ).toBe(false);
  });

  it.each(['https://evil.example/api', '//evil.example/api', 'api', '/api?x=1'])(
    'rejects apiBasePath %s (token must stay same-origin)',
    (apiBasePath) => {
      expect(runtimeConfigSchema.safeParse({ ...valid, apiBasePath }).success).toBe(false);
    },
  );
});

describe('own login settings (D20)', () => {
  it.each([[[]], [['Empresa.com']], [['*.empresa.com']], [['empres\u0430.com']]])(
    'rejects signUpDomains %j',
    (signUpDomains) => {
      expect(runtimeConfigSchema.safeParse({ ...valid, signUpDomains }).success).toBe(false);
    },
  );

  it('derives the Cognito API endpoint from the region unless overridden locally', () => {
    const config = runtimeConfigSchema.parse(valid);
    expect(cognitoIdpEndpoint(config)).toBe('https://cognito-idp.us-east-1.amazonaws.com/');
    expect(
      runtimeConfigSchema.safeParse({ ...valid, cognitoIdpEndpoint: 'http://evil.example' })
        .success,
    ).toBe(false);
  });

  it('accepts an optional https AI use policy URL', () => {
    expect(runtimeConfigSchema.parse(valid).aiPolicyUrl).toBeUndefined();
    const url = 'https://intranet.empresa.com/politica-ia';
    expect(runtimeConfigSchema.parse({ ...valid, aiPolicyUrl: url }).aiPolicyUrl).toBe(url);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    'http://intranet.empresa.com/ia',
    'http://localhost/ia',
    'https://user:pass@intranet.empresa.com/ia',
    '/politica',
    '',
  ])('rejects aiPolicyUrl %j', (aiPolicyUrl) => {
    expect(runtimeConfigSchema.safeParse({ ...valid, aiPolicyUrl }).success).toBe(false);
  });

  it('accepts an SSO provider name only with safe characters', () => {
    expect(runtimeConfigSchema.safeParse({ ...valid, ssoProvider: 'EntraID' }).success).toBe(true);
    expect(
      runtimeConfigSchema.safeParse({ ...valid, ssoProvider: 'x&redirect_uri=evil' }).success,
    ).toBe(false);
  });
});

describe('installation auth policy', () => {
  it('is required', () => {
    expect(runtimeConfigSchema.safeParse({ ...valid, auth: undefined }).success).toBe(false);
  });

  it.each([
    { installationType: 'customer', mfa: 'optional', sessionHours: 12 },
    { installationType: 'saas', mfa: 'required', sessionHours: 12 },
    { installationType: 'lab', mfa: 'off', sessionHours: 0 },
    { installationType: 'lab', mfa: 'off', sessionHours: 25 },
    { installationType: 'lab', mfa: 'off', sessionHours: 1.5 },
  ])('rejects %j', (auth) => {
    expect(runtimeConfigSchema.safeParse({ ...valid, auth }).success).toBe(false);
  });
});

describe('loadRuntimeConfig', () => {
  it('fetches /config.json without caching', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(valid)));
    await expect(loadRuntimeConfig(fetchMock)).resolves.toMatchObject({ region: 'us-east-1' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/config.json',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('fails on invalid config', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ region: 'x' })));
    await expect(loadRuntimeConfig(fetchMock)).rejects.toBeInstanceOf(RuntimeConfigError);
  });
});
