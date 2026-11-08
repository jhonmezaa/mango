import { describe, expect, it } from 'vitest';

import {
  fileLinkTarget,
  isFileLink,
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

describe('links to the files of an answer (C4, rea-gaps §2.3)', () => {
  const sheet = { file_id: '01' + 'A'.repeat(24), name: 'detalle.xlsx' };
  const chart = { file_id: '01' + 'B'.repeat(24), name: 'costo por mes.png' };
  const files = [sheet, chart];

  it('names an announced file by id or by its name under /mnt/data', () => {
    expect(fileLinkTarget(`mango-file:${sheet.file_id}`, files)).toBe(sheet.file_id);
    expect(fileLinkTarget('sandbox:/mnt/data/detalle.xlsx', files)).toBe(sheet.file_id);
    expect(fileLinkTarget('sandbox:/mnt/data/costo%20por%20mes.png', files)).toBe(chart.file_id);
  });

  it.each([
    'mango-file:01ZZZZZZZZZZZZZZZZZZZZZZZZ',
    'sandbox:/mnt/data/otro.xlsx',
    'sandbox:/mnt/data/sub/detalle.xlsx',
    'sandbox:/mnt/data/../data/detalle.xlsx',
    'sandbox:/mnt/data/%2e%2e/detalle.xlsx',
    'sandbox:/mnt/data/detalle.xlsx/',
    'sandbox:/mnt/data/detalle%0a.xlsx',
    'sandbox:/etc/passwd',
    'sandbox:/mnt/data/%25252525252e%25252525252e/x',
    `sandbox:/mnt/data/${'a'.repeat(4100)}`,
  ])('refuses %s', (href) => {
    expect(fileLinkTarget(href, files)).toBeNull();
  });

  it('is kept by the Markdown transform only when it may name a file', () => {
    expect(isFileLink('sandbox:/mnt/data/detalle.xlsx')).toBe(true);
    expect(markdownUrlTransform('sandbox:/mnt/data/detalle.xlsx')).toBe(
      'sandbox:/mnt/data/detalle.xlsx',
    );
    expect(markdownUrlTransform('sandbox:/mnt/data/../x')).toBe('');
    expect(markdownUrlTransform('mango-file:x')).toBe('mango-file:x');
    expect(markdownUrlTransform('javascript:alert(1)')).toBe('');
  });
});
