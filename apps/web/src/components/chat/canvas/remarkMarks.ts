/**
 * A remark plugin that marks the quotes of the Canvas comments in the document (design round 41:
 * «El texto citado se marca en ámbar»). It works on the Markdown tree, never on HTML: a quote
 * found inside one text node becomes a `<mark class="cv-mark">` with the same text (React
 * escapes it). A quote that spans formatting is matched by its first table cell (as the
 * design's `quote.split(' | ')[0]`), or not marked.
 */

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  data?: Record<string, unknown>;
}

const SKIP = new Set(['code', 'inlineCode', 'html']);

/** What is looked for of each quote: the quote itself, or its first table cell. */
export function needles(quotes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const quote of quotes) {
    const first = quote.split(' | ')[0]?.trim() ?? '';
    if (first.length >= 2) out.add(first);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function split(text: string, wanted: readonly string[]): Node[] | null {
  for (const needle of wanted) {
    const at = text.indexOf(needle);
    if (at < 0) continue;
    const out: Node[] = [];
    if (at > 0) out.push({ type: 'text', value: text.slice(0, at) });
    out.push({
      type: 'mark',
      data: { hName: 'mark', hProperties: { className: ['cv-mark'] } },
      children: [{ type: 'text', value: needle }],
    });
    const rest = text.slice(at + needle.length);
    if (rest) out.push(...(split(rest, wanted) ?? [{ type: 'text', value: rest }]));
    return out;
  }
  return null;
}

function walk(node: Node, wanted: readonly string[]): void {
  if (!node.children || SKIP.has(node.type) || node.type === 'mark') return;
  const next: Node[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      next.push(...(split(child.value, wanted) ?? [child]));
    } else {
      walk(child, wanted);
      next.push(child);
    }
  }
  node.children = next;
}

export function remarkMarks(quotes: readonly string[]) {
  const wanted = needles(quotes);
  return () => (tree: Node) => {
    if (wanted.length > 0) walk(tree, wanted);
  };
}
