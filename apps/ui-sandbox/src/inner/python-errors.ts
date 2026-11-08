/** Python errors as the person reads them (Pyodide's own frames left out). */

/** The line of the user's code where a Python error happened, from its traceback. */
export function errorLine(message: string): number | undefined {
  const lines = [...message.matchAll(/File "<exec>", line (\d+)/g)];
  const last = lines.at(-1)?.[1];
  return last === undefined ? undefined : Number(last);
}

/** The end of a traceback, without the frames of Pyodide itself. */
export function cleanTraceback(message: string): string {
  const start = message.indexOf('File "<exec>"');
  const text =
    start >= 0 ? `Traceback (most recent call last):\n  ${message.slice(start)}` : message;
  return text.trim().slice(-3000);
}
