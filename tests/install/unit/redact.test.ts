import { describe, expect, it } from 'vitest';

import { createRedactor, maskUrl } from '../src/redact.ts';

describe('createRedactor', () => {
  const redact = createRedactor([
    { value: 'admin-prueba@empresa.com', label: 'admin' },
    { value: 'admin-prueba', label: 'admin' },
    { value: 'app.example.com', label: 'instalación' },
    { value: 'correct horse battery', label: 'secreto' },
  ]);

  it('replaces what the run knows by its role', () => {
    expect(
      redact('Locator: getByText("admin-prueba@empresa.com") at https://app.example.com/x'),
    ).toBe('Locator: getByText("<admin>") at https://<instalación>/x');
    expect(redact('typed correct horse battery')).toBe('typed <secreto>');
  });

  it('masks the shapes an installation can show', () => {
    const text = [
      'otra.persona+x@empresa.com',
      'cuenta 111122223333',
      'd123.cloudfront.net',
      'us-east-1_AbCdEfGhI',
      'o-exampleorg1',
      'arn:aws:iam::111122223333:role/Mango-ns-api',
      '14f8d4e8-80d1-702d-3db4-c6ebea3869fd',
      'eyJhbGciOiJ.eyJzdWIiOiIx.c2lnbmF0dXJl',
    ].join(' | ');
    const out = redact(text);
    expect(out).toBe(
      '<correo> | cuenta <cuenta> | <host> | <directorio> | <organización> | <arn> | <id> | <token>',
    );
  });

  it('leaves ordinary text, times and short numbers alone', () => {
    const text = 'Expected: 204 · Received: 403 · 2026-10-05T20:00:00Z · v0.1.0-g0000000';
    expect(redact(text)).toBe(text);
  });
});

describe('maskUrl', () => {
  it('keeps enough of the host to tell two installations apart, and no path', () => {
    expect(maskUrl('https://d123.cloudfront.net/settings')).toBe('https://d***.cloudfront.net');
    expect(maskUrl('https://mango.empresa.com')).toBe('https://m***.empresa.com');
    expect(maskUrl('https://example.com')).toBe('https://e***');
  });
});
