import { describe, expect, it } from 'vitest';

import {
  markdownUrlTransform,
  parseExternalHttpUrl,
  safeHttpsHref,
  safeReturnPath,
} from './safeUrl';

describe('parseExternalHttpUrl', () => {
  it.each(['https://example.com/a?b=1', 'http://example.com'])('accepts %s', (value) => {
    expect(parseExternalHttpUrl(value)?.href).toBeDefined();
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox',
    '/relative',
    '//evil.example',
    'https://user:pass@example.com',
    '',
  ])('rejects %s', (value) => {
    expect(parseExternalHttpUrl(value)).toBeNull();
    expect(markdownUrlTransform(value)).toBe('');
  });
});

describe('safeReturnPath', () => {
  it.each([
    ['/c/01JX?x=1#y', '/c/01JX?x=1#y'],
    ['/admin', '/admin'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['javascript:alert(1)', '/'],
    [undefined, '/'],
    [42, '/'],
  ])('%s -> %s', (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });
});

describe('safeHttpsHref', () => {
  it('keeps absolute https URLs', () => {
    expect(safeHttpsHref('https://intranet.example.com/ia')).toBe(
      'https://intranet.example.com/ia',
    );
  });

  it.each([
    undefined,
    '',
    'javascript:alert(1)',
    ' JavaScript:alert(1)',
    'data:text/html,x',
    'http://intranet.example.com/ia',
    'https://user:pass@example.com',
    '//evil.example',
  ])('rejects %j', (value) => {
    expect(safeHttpsHref(value)).toBeNull();
  });
});
