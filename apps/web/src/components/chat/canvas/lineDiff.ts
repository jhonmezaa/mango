/** One line of «Mostrar cambios»: kept (` `), added (`+`) or removed (`-`). */
export type DiffLine = readonly [' ' | '+' | '-', string];

/**
 * The lines of `before` and `after` as «Mostrar cambios» shows them (design round 41 `lineDiff`):
 * a line both have stays, a line only one has is added or removed. Pure text: the caller renders
 * it escaped (React), never as HTML.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const inA = new Set(a);
  const inB = new Set(b);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && right !== undefined && left === right) {
      out.push([' ', left]);
      i += 1;
      j += 1;
    } else if (right !== undefined && !inA.has(right)) {
      out.push(['+', right]);
      j += 1;
    } else if (left !== undefined && !inB.has(left)) {
      out.push(['-', left]);
      i += 1;
    } else {
      if (left !== undefined) {
        out.push(['-', left]);
        i += 1;
      }
      if (right !== undefined) {
        out.push(['+', right]);
        j += 1;
      }
    }
  }
  return out;
}
