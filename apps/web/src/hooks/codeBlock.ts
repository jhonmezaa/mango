import type { CodeCell, CodeFile } from '../api/codeSchemas';

/**
 * The «Analizando» block of an answer (design round 40 `CodeBlock`, rea-gaps §2.4): one header
 * for every cell of the answer. The cells come from the API (C4); a call still running has no
 * cell yet and shows as «corriendo».
 */
export const CODE_RECIPIENT = 'code.run_python';
/** The display name of the cell tool in a stored answer's tool list. */
export const CODE_TOOL_NAME = 'run_python';

export type CodeBlockState = 'running' | 'completed' | 'error' | 'paused';

export interface CodeBlockData {
  cells: CodeCell[];
  /** Calls of the cell tool without their cell yet (live only). */
  pending: number;
}

/**
 * The state of the block (rea-gaps §2.4, in this order): a call in flight while the answer
 * streams is `running`; a cell that failed or reached its cutoff is `error`; a call left without
 * its cell when the answer stopped is `paused`; otherwise `completed`.
 */
export function codeBlockState(block: CodeBlockData, streaming: boolean): CodeBlockState {
  if (block.pending > 0 && streaming) return 'running';
  if (block.cells.some((cell) => cell.status !== 'completed' && !cell.blocked)) return 'error';
  if (block.pending > 0) return 'paused';
  return 'completed';
}

/** Total time of the cells that reported it, in ms (header «{n} celdas · {duración}»). */
export function codeBlockMs(block: CodeBlockData): number {
  return block.cells.reduce((total, cell) => total + (cell.seconds ?? 0) * 1000, 0);
}

/** The stderr line the connector adds when a cell reaches its cutoff; the block says it itself. */
const CUTOFF_LINE = /\n?The cell was stopped after \d+ seconds\.\s*$/;

export function shownStderr(cell: CodeCell): string {
  return cell.status === 'timeout' ? cell.stderr.replace(CUTOFF_LINE, '') : cell.stderr;
}

/** The figures of the block: the images its cells wrote that are still there. */
export function codeFigures(block: CodeBlockData): CodeFile[] {
  return block.cells.flatMap((cell) => cell.files.filter((file) => file.image && !file.gone));
}

/** The files of the answer shown as cards (any other kind, or an image no longer there). */
export function codeFileCards(block: CodeBlockData): CodeFile[] {
  return block.cells.flatMap((cell) => cell.files.filter((file) => !file.image || file.gone));
}

/** The files a link of this answer may name (`mango-file:`, `sandbox:/mnt/data/`). */
export function announcedFiles(block: CodeBlockData | undefined): CodeFile[] {
  return block ? block.cells.flatMap((cell) => cell.files) : [];
}

/** Design round 40 `crSize`: «1,2 MB» from one MB, «88 KB» below it, in the browser's locale. */
export function fileSize(bytes: number): string {
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;
}
