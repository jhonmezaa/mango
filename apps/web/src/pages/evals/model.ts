import type { OperationInput, OperationOutput } from '../../api/operations';

// Evals (design evals.jsx, eval-create.jsx; D110, D111). Pure helpers of the view: what a suite
// shows from what the API returns. The API decides who sees and who edits each suite; these only
// read its answer (REACT-AUTHZ-001).

export type SuiteList = OperationOutput<'getEvals'>;
export type Suite = SuiteList['suites'][number];
export type SuiteDetail = OperationOutput<'getEvalSuite'>;
export type SuiteCase = SuiteDetail['cases'][number];
export type EvalRun = OperationOutput<'getEvalRuns'>['runs'][number];
export type Attempt = NonNullable<Suite['last_attempt']>;
export type Kind = Suite['kind'];
export type Criterion = SuiteCase['criterion'];
export type NewCase = OperationInput<'postEvalSuite'>['body']['cases'][number];

/** Design EV_TYPES, without «Revisión humana» (not built: «Próximamente» when creating). */
export const KINDS: readonly Kind[] = ['golden', 'regression', 'security'];
export const CRITERIA: readonly Criterion[] = ['contains', 'uses_tool', 'no_disclosure', 'judge'];
/** API limits (mango_core.evals): the server checks them again. */
export const MAX_CASES = 50;
export const MAX_QUESTION_CHARS = 1000;
export const MAX_VALUE_CHARS = 200;
export const MAX_CSV_BYTES = 30 * 1024;
export const MAX_NAME_CHARS = 80;
export const MIN_THRESHOLD = 50;
/** Design: «Muestra de {n} de {total} casos». */
export const SAMPLE_CASES = 8;

export type SuiteStatus = 'pass' | 'fail' | 'pending';

/** Design `e.status`: the last complete run, or none yet. */
export function statusOf(suite: Pick<Suite, 'last_run'>): SuiteStatus {
  if (!suite.last_run) return 'pending';
  return suite.last_run.passed ? 'pass' : 'fail';
}

/** Design «Bloquean la aprobación»: required and its last complete run did not pass. */
export function blocks(suite: Pick<Suite, 'required' | 'last_run'>): boolean {
  return suite.required && statusOf(suite) === 'fail';
}

/** Score difference with the run before (design `d`), in points; null with fewer than two. */
export function trendDelta(scores: readonly number[]): number | null {
  if (scores.length < 2) return null;
  return (scores.at(-1) ?? 0) - (scores.at(-2) ?? 0);
}

/**
 * Why the most recent run ended without counting (design EV_RUN and the states of HANDOFF), from
 * the codes of the API (`stop_reason`). A run that passed or failed has no issue.
 */
export type Issue =
  | 'nobudget'
  | 'stopbudget'
  | 'failed'
  | 'gone'
  | 'access_lost'
  | 'suite_changed'
  | 'unavailable'
  | 'model_unavailable';

export function issueOf(attempt: Attempt | null | undefined): Issue | null {
  if (!attempt) return null;
  if (attempt.status === 'error') return 'failed';
  if (attempt.status !== 'stopped') return null;
  switch (attempt.stop_reason) {
    case 'budget':
      return attempt.cases_done === 0 ? 'nobudget' : 'stopbudget';
    case 'version_changed':
    case 'version_not_testable':
      return 'gone';
    case 'access_lost':
      return 'access_lost';
    case 'suite_changed':
      return 'suite_changed';
    case 'evals_unavailable':
      return 'unavailable';
    case 'model_unavailable':
      return 'model_unavailable';
    default:
      return 'failed';
  }
}

/** Red in the row (design: «Falló» red, the budget ones amber). */
export function issueTone(issue: Issue): 'red' | 'amber' {
  return issue === 'nobudget' || issue === 'stopbudget' || issue === 'access_lost'
    ? 'amber'
    : 'red';
}

/** The case a stopped run reached (design «Se detuvo … en el caso {n} de {total}»). */
export function stoppedAt(attempt: Attempt): number {
  return Math.min(attempt.case_count, attempt.cases_done + 1);
}

/** Runs that count (design: a stopped or failed one does not), newest first. */
export function countedRuns(runs: readonly EvalRun[]): EvalRun[] {
  return runs.filter((run) => run.status === 'passed' || run.status === 'failed');
}

/** The cases of a suite with the verdict of its last complete run (design evCases). */
export interface CaseRow {
  question: string;
  criterion: Criterion;
  value: string;
  verdict: 'ok' | 'fail' | 'pending';
  reason: string | null;
}

export function caseRows(cases: readonly SuiteCase[], run: EvalRun | null): CaseRow[] {
  return cases.map((item, index) => {
    const result = run?.cases[index];
    const verdict =
      !result || result.status === 'pending' || result.status === 'judge'
        ? 'pending'
        : result.status === 'pass'
          ? 'ok'
          : 'fail';
    return {
      question: item.question,
      criterion: item.criterion,
      value: item.value,
      verdict,
      reason: verdict === 'fail' ? (result?.reason ?? null) : null,
    };
  });
}

/** Design: the failing cases first, so the sample shows them. */
export function sample(rows: readonly CaseRow[]): CaseRow[] {
  const failing = rows.filter((row) => row.verdict === 'fail');
  const rest = rows.filter((row) => row.verdict !== 'fail');
  return [...failing, ...rest].slice(0, SAMPLE_CASES);
}

// --- Review (D26): where the required suites stand for the version under review ---------------

export type GateState = 'passed' | 'failed' | 'running' | 'waiting' | 'not_run';

/** Like the server's `EvalGate.state`, for the version's `content_hash`. The server decides. */
export function gateState(suite: Suite, contentHash: string | null): GateState {
  const active = suite.active_run;
  if (active) return active.status === 'queued' ? 'waiting' : 'running';
  const run = suite.last_run;
  if (!run || !contentHash || run.content_hash !== contentHash) return 'not_run';
  return run.passed ? 'passed' : 'failed';
}

export interface Gate {
  suites: Suite[];
  running: Suite[];
  waiting: Suite[];
  failing: Suite[];
  /** Required suites without a run of this version that ended (not run, stopped, another). */
  unfinished: Suite[];
}

export function gateOf(suites: readonly Suite[], contentHash: string | null): Gate {
  const required = suites.filter((suite) => suite.required);
  const by = (state: GateState) =>
    required.filter((suite) => gateState(suite, contentHash) === state);
  return {
    suites: [...suites],
    running: by('running'),
    waiting: by('waiting'),
    failing: by('failed'),
    unfinished: by('not_run'),
  };
}

export function gateBlocks(gate: Gate): boolean {
  return (
    gate.running.length + gate.waiting.length + gate.failing.length + gate.unfinished.length > 0
  );
}

// --- CSV (design ecParseCsv, the API's format) ---------------------------------------------------

/** The header of the API (`mango_core.evals.CSV_HEADER`). */
const CSV_HEADER = ['pregunta', 'respuesta esperada', 'criterio'] as const;

export type CsvError =
  | { code: 'csv_empty' }
  | { code: 'csv_header' }
  | { code: 'csv_too_large' }
  | { code: 'too_many_cases' }
  | { code: 'csv_invalid' }
  | { code: 'csv_rows'; rows: number[] };

/** RFC 4180 rows: quotes, doubled quotes and newlines inside quotes. Null if a quote is open. */
function csvRows(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quoted) {
      if (char === '"') {
        if (text.charAt(index + 1) === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text.charAt(index + 1) === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (quoted) return null;
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** `contiene: x`, `usa la tool: servidor.tool`, `no revela` or empty for the judge. */
export function criterionOf(raw: string): { criterion: Criterion; value: string } | null {
  const text = raw.trim();
  if (!text) return { criterion: 'judge', value: '' };
  const colon = text.indexOf(':');
  const head = (colon >= 0 ? text.slice(0, colon) : text).trim().toLowerCase();
  const tail = colon >= 0 ? text.slice(colon + 1).trim() : '';
  if (colon >= 0 && head === 'contiene' && tail) return { criterion: 'contains', value: tail };
  if (colon >= 0 && head === 'usa la tool' && tail) return { criterion: 'uses_tool', value: tail };
  if (colon < 0 && head === 'no revela') return { criterion: 'no_disclosure', value: '' };
  return null;
}

/**
 * The cases of a CSV, all or nothing, like the API (`mango_core.evals.parse_csv`): the problems
 * are named by row number, never by echoing a value. The API parses and validates again.
 */
export function parseCsv(text: string): { cases: NewCase[] } | { error: CsvError } {
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES) {
    return { error: { code: 'csv_too_large' } };
  }
  const rows = csvRows(text.replace(/^\uFEFF/, ''));
  if (!rows) return { error: { code: 'csv_invalid' } };
  const filled = rows.filter((row) => row.some((cell) => cell.trim()));
  const [header, ...data] = filled;
  if (!header) return { error: { code: 'csv_empty' } };
  const names = header.map((cell) => cell.trim().toLowerCase());
  if (names.length !== CSV_HEADER.length || names.some((name, i) => name !== CSV_HEADER[i])) {
    return { error: { code: 'csv_header' } };
  }
  if (!data.length) return { error: { code: 'csv_empty' } };
  if (data.length > MAX_CASES) return { error: { code: 'too_many_cases' } };
  const cases: NewCase[] = [];
  const bad: number[] = [];
  data.forEach((row, index) => {
    const [question = '', expected = '', raw = ''] = row;
    const criterion = row.length === 3 ? criterionOf(raw) : null;
    const q = question.trim();
    if (!criterion || !q || q.length > MAX_QUESTION_CHARS || criterion.value.length > 200) {
      bad.push(index + 1);
      return;
    }
    if (criterion.criterion === 'judge' && !expected.trim()) {
      bad.push(index + 1);
      return;
    }
    cases.push({ question: q, expected: expected.trim(), ...criterion });
  });
  if (bad.length) return { error: { code: 'csv_rows', rows: bad } };
  return { cases };
}

/** What a case still lacks before the suite can be created (design step 3). */
export function caseIncomplete(item: NewCase): boolean {
  if (item.criterion === 'contains' || item.criterion === 'uses_tool') return !item.value?.trim();
  if (item.criterion === 'judge') return !item.expected?.trim();
  return false;
}
