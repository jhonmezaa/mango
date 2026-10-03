import type { ExtraProps } from 'react-markdown';

type HastElement = NonNullable<ExtraProps['node']>;
type HastNode = HastElement['children'][number];
interface HastParent {
  children: HastNode[];
}

/**
 * A figure, amount or percentage (design markdown.js `NUM`): optional sign and currency, digits
 * with separators, optional unit.
 */
const NUMERIC = /^[-+−]?\s*(USD|US\$|\$|€|MXN)?\s*[-+−]?[\d][\d.,\s]*\s*(%|ms|s|h|d|k|K|M|MB|GB)?$/;

// The text comes from the model: the length cap keeps the regex (adjacent `\s*` groups) cheap
// whatever a cell contains. No real figure is longer.
const MAX_NUMERIC_LENGTH = 40;

export function isNumericCell(text: string): boolean {
  const value = text.trim();
  return value.length <= MAX_NUMERIC_LENGTH && NUMERIC.test(value);
}

function childElements(parent: HastParent, tagName: string): HastElement[] {
  return parent.children.filter(
    (child): child is HastElement => child.type === 'element' && child.tagName === tagName,
  );
}

/**
 * Text of a cell made only of plain text and bold (the design tests the cell source without
 * `**`); `null` when it holds anything else (code, links, emphasis), which is never a figure.
 */
function plainText(parent: HastParent): string | null {
  let text = '';
  for (const child of parent.children) {
    if (child.type === 'text') {
      text += child.value;
    } else if (child.type === 'element' && child.tagName === 'strong') {
      const inner = plainText(child);
      if (inner === null) return null;
      text += inner;
    } else {
      return null;
    }
  }
  return text;
}

function cellsOf(row: HastElement): HastElement[] {
  return row.children.filter(
    (child): child is HastElement =>
      child.type === 'element' && (child.tagName === 'td' || child.tagName === 'th'),
  );
}

function alignTable(table: HastElement): void {
  const headRows = childElements(table, 'thead').flatMap((head) => childElements(head, 'tr'));
  const bodyRows = childElements(table, 'tbody').flatMap((body) => childElements(body, 'tr'));
  const body = bodyRows.map(cellsOf);
  const columns = Math.max(0, ...headRows.map((row) => cellsOf(row).length));

  const numeric: boolean[] = [];
  for (let column = 0; column < columns; column += 1) {
    let filled = 0;
    let allNumeric = true;
    for (const cells of body) {
      const cell = cells[column];
      const text = cell ? plainText(cell) : '';
      if (text !== null && text.trim() === '') continue;
      filled += 1;
      if (text === null || !isNumericCell(text)) {
        allNumeric = false;
        break;
      }
    }
    numeric.push(filled > 0 && allNumeric);
  }

  for (const row of [...headRows, ...bodyRows]) {
    cellsOf(row).forEach((cell, column) => {
      // The GFM alignment markers (`---:`) are ignored, as in the design: only the content
      // decides. Dropping `align` also keeps react-markdown from emitting an inline style.
      const properties = { ...cell.properties };
      delete properties.align;
      cell.properties = numeric[column] ? { ...properties, className: ['num'] } : properties;
    });
  }
}

function visit(node: HastParent): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.tagName === 'table') alignTable(child);
    else visit(child);
  }
}

/**
 * Rehype plugin for the design's table rule (markdown.js): a column is right-aligned (`.num`)
 * when it has at least one body cell and every non-empty body cell is a figure; its header cell
 * follows. It only sets a class name on `th`/`td`.
 */
export function rehypeNumericColumns() {
  return (tree: HastParent): void => {
    visit(tree);
  };
}
