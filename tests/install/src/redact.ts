// Masking of everything a run writes: console, report, failure messages. Two layers: the values
// this run knows (addresses of the test users, the host of the installation, their secrets) and
// the shapes of what an installation can show (addresses, account ids, tokens, ARNs).

export interface Literal {
  /** The exact text to hide. */
  value: string;
  /** What is written instead, without the angle brackets. */
  label: string;
}

export type Redactor = (text: string) => string;

const SHAPES: readonly (readonly [RegExp, string])[] = [
  [/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<token>'],
  [/arn:aws[\w-]*:[^\s"'`<>)]+/g, '<arn>'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<correo>'],
  [/\b[a-z0-9-]+\.cloudfront\.net\b/gi, '<host>'],
  [/\b[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com\b/gi, '<host>'],
  [/\b[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{6,}\b/g, '<directorio>'],
  [/\bo-[a-z0-9]{10,32}\b/g, '<organización>'],
  [/\b(?:ou|r)-[a-z0-9]{4,32}(?:-[a-z0-9]{8,32})?\b/g, '<ou>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, '<id>'],
  [/(?<![\w.])\d{12}(?![\w.])/g, '<cuenta>'],
];

/** Patterns of the same shapes for `page.getByText`, to mask screenshots. */
export const SCREEN_SHAPES: readonly RegExp[] = [
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/,
  /\b\d{12}\b/,
  /\bo-[a-z0-9]{10,32}\b/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b[0-9A-HJKMNP-TV-Z]{26}\b/,
  /\b[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{6,}\b/,
];

/**
 * Returns the function that masks a text. Known values go first and longest first, so an
 * address is replaced by its role (`<admin>`) before the generic shape sees it.
 */
export function createRedactor(literals: readonly Literal[]): Redactor {
  const known = literals
    .filter((literal) => literal.value.length >= 4)
    .toSorted((a, b) => b.value.length - a.value.length);
  return (text) => {
    let out = text;
    for (const { value, label } of known) out = out.split(value).join(`<${label}>`);
    for (const [shape, label] of SHAPES) out = out.replace(shape, label);
    return out;
  };
}

/** `https://d1abc.example.net/x` → `https://d***.example.net`: enough to tell two installations apart. */
export function maskUrl(url: string): string {
  const { protocol, hostname } = new URL(url);
  const labels = hostname.split('.');
  if (labels.length <= 2) return `${protocol}//${hostname.slice(0, 1)}***`;
  const [first = '', ...rest] = labels;
  return `${protocol}//${first.slice(0, 1)}***.${rest.slice(-2).join('.')}`;
}
