import type { ReactNode } from 'react';

const SLOT = '';

/**
 * Renders a translation that marks bold text with `<b>…</b>`. The tags are parsed from the
 * static template only; `value` (an email) is inserted afterwards as a text node, so it can
 * never add markup (REACT-XSS-002).
 */
export function Bold({
  translate,
  value = '',
}: {
  /** Returns the translation with `SLOT` in place of the interpolated value. */
  translate: (slot: string) => string;
  value?: string;
}): ReactNode {
  const template = translate(SLOT);
  const fill = (text: string) => text.split(SLOT).join(value);
  return template
    .split(/(<b>.*?<\/b>)/)
    .filter(Boolean)
    .map((part, i) =>
      part.startsWith('<b>') && part.endsWith('</b>') ? (
        <b key={i}>{fill(part.slice(3, -4))}</b>
      ) : (
        <span key={i}>{fill(part)}</span>
      ),
    );
}
