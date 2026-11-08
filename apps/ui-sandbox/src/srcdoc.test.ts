import { describe, expect, it } from 'vitest';

import { buildSrcdoc, escapeAttribute, escapeScript } from './srcdoc';

const parts = {
  source: '',
  csp: "default-src 'none'",
  bootstrap: 'void 0;',
  origin: 'https://d123.cloudfront.net',
};

describe('buildSrcdoc', () => {
  it('puts the policy first, before any script', () => {
    for (const kind of ['html', 'react', 'python'] as const) {
      const doc = buildSrcdoc({ ...parts, kind, source: '<script>x()</script>' });
      const meta = doc.indexOf('http-equiv="Content-Security-Policy"');
      expect(meta).toBeGreaterThan(0);
      expect(doc.indexOf('<script')).toBeGreaterThan(meta);
    }
  });

  it('keeps the code of React and Python runs out of the document', () => {
    for (const kind of ['react', 'python'] as const) {
      expect(buildSrcdoc({ ...parts, kind, source: 'SECRET_SOURCE' })).not.toContain(
        'SECRET_SOURCE',
      );
    }
  });

  it('maps only the mirror in the import map of a React run', () => {
    const doc = buildSrcdoc({ ...parts, kind: 'react' });
    const map = /<script type="importmap">(.*?)<\/script>/.exec(doc)?.[1] ?? '{}';
    const imports = Object.values((JSON.parse(map) as { imports: Record<string, string> }).imports);
    expect(imports.length).toBeGreaterThan(0);
    for (const url of imports) expect(url.startsWith(`${parts.origin}/vendor/`)).toBe(true);
  });

  it('a policy cannot break out of its attribute, nor the bootstrap out of its script', () => {
    expect(escapeAttribute('"><script>')).toBe('&quot;&gt;&lt;script&gt;');
    expect(escapeScript('a</script><b><!--')).toBe('a<\\/script><b><\\!--');
    expect(escapeScript('</SCRIPT>')).toBe('<\\/SCRIPT>');
  });
});
