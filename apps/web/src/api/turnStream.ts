import {
  DeltaError,
  NOT_STARTED,
  NO_CHANNELS,
  receiveDelta,
  startConnection,
  type Channels,
  type Connection,
} from './deltas';
import { ApiError, NotAuthenticatedError } from './errors';
import { SseParser, SseProtocolError } from './sse';

/**
 * Reading a chat turn in `v1` (D120 (4)): `GET /api/chat/turns/{turn}/stream?after=<n>`, again
 * and again until the turn ends. A cut connection, or an answer the API says to retry (408,
 * 409, 425, 429, 502, 504), opens a new one with `after` = the last delta applied: nothing is
 * applied twice nor lost. 12 attempts, 300 ms × 1.5 each, up to 5 s, with 50 % jitter; an
 * attempt that brings something new starts the count again. 401 ends the session; 403, 404 and
 * any other answer stop reading (the person can ask again with «Volver a conectar»).
 */

export const MAX_ATTEMPTS = 12;
export const FIRST_DELAY_MS = 300;
export const DELAY_FACTOR = 1.5;
export const MAX_DELAY_MS = 5000;
/** Jitter: each wait is between half of its delay and all of it. */
export const JITTER = 0.5;
/**
 * The API says something at least every 15 s (a `: ping`); twice that and a half without a byte
 * means the connection is gone even if the browser has not noticed.
 */
export const IDLE_MS = 45_000;

const RETRY_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429, 502, 504]);

/** The wait before attempt `attempt` (1-based), without jitter. */
export function baseDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * DELAY_FACTOR ** (attempt - 1));
}

/** The wait before attempt `attempt`, with jitter from `random` in [0, 1). */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  return Math.round(baseDelay(attempt) * (1 - JITTER * random()));
}

/** What the person sees of the connection while the turn is read. */
export type ConnectionState =
  | { kind: 'live' }
  | { kind: 'reconnecting'; attempt: number }
  /** A connection opened again after a cut: «Reconectado», then `live`. */
  | { kind: 'resumed' };

/** Where a turn's reading stands: kept between connections and between readings. */
export interface TurnProgress {
  channels: Channels;
  /** Id of the last delta applied (`after` of the next connection). */
  lastId: number;
}

export const TURN_START: TurnProgress = { channels: NO_CHANNELS, lastId: 0 };

export type TurnEnd =
  /** `message_stream_complete` and `[DONE]`: the worker closed the turn. */
  | { kind: 'complete'; progress: TurnProgress }
  /** The reading stopped without the end: 12 attempts, or an answer that is not retried. */
  | { kind: 'failed'; progress: TurnProgress; status: number | null; code: string }
  /** 401, or no session to ask with: the session ended. */
  | { kind: 'unauthenticated'; progress: TurnProgress }
  | { kind: 'aborted'; progress: TurnProgress };

export interface FollowOptions {
  /** Opens one connection from delta `after + 1`; rejects with `ApiError` when it is not 200. */
  open: (after: number, signal: AbortSignal) => Promise<Response>;
  signal: AbortSignal;
  /** Where a previous reading of this turn stopped («Volver a conectar»). */
  from?: TurnProgress;
  onProgress: (progress: TurnProgress) => void;
  onConnection: (state: ConnectionState) => void;
  /** Injected by tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  idleMs?: number;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** How one connection ended. */
type Outcome =
  | { kind: 'complete' }
  /** Cut before its end: retried. `fresh` when it applied something new. */
  | { kind: 'cut'; fresh: boolean }
  | { kind: 'error'; error: unknown; fresh: boolean };

class Reader {
  private connection: Connection = NOT_STARTED;
  private complete = false;
  private finished = false;
  fresh = false;

  constructor(
    public progress: TurnProgress,
    private readonly onProgress: (progress: TurnProgress) => void,
    private readonly onStarted: () => void,
  ) {}

  /** Handles one SSE event; returns true once `[DONE]` arrived after the end. */
  handle(event: string, data: string, id: number | null): boolean {
    if (event === 'delta_encoding') {
      this.connection = startConnection(JSON.parse(data) as unknown);
      this.onStarted();
      return false;
    }
    if (event === 'delta') {
      // A delta already applied (a server that replays more than asked) is skipped.
      if (id !== null && id <= this.progress.lastId) return false;
      const applied = receiveDelta(this.connection, this.progress.channels, JSON.parse(data));
      this.connection = applied.connection;
      this.progress = { channels: applied.channels, lastId: id ?? this.progress.lastId };
      this.fresh = true;
      this.onProgress(this.progress);
      return false;
    }
    if (event === 'message_stream_complete') {
      this.complete = true;
      return false;
    }
    if (event === 'message' && data === '[DONE]') {
      this.finished = this.complete;
      return this.finished;
    }
    // Unknown events are skipped (forward compatible).
    return false;
  }

  get done(): boolean {
    return this.finished;
  }
}

async function readConnection(
  response: Response,
  reader: Reader,
  signal: AbortSignal,
  idleMs: number,
  cut: () => void,
): Promise<Outcome> {
  if (!response.body) return { kind: 'cut', fresh: false };
  const stream = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = new SseParser();
  let idle = setTimeout(cut, idleMs);
  try {
    for (;;) {
      const { done, value } = await stream.read();
      clearTimeout(idle);
      if (done) break;
      idle = setTimeout(cut, idleMs);
      for (const message of parser.push(value)) {
        const id =
          message.id !== undefined && /^\d{1,9}$/.test(message.id) ? Number(message.id) : null;
        if (reader.handle(message.event, message.data, id)) {
          return { kind: 'complete' };
        }
      }
    }
    return { kind: 'cut', fresh: reader.fresh };
  } catch (error) {
    if (signal.aborted) return { kind: 'cut', fresh: reader.fresh };
    return { kind: 'error', error, fresh: reader.fresh };
  } finally {
    clearTimeout(idle);
    stream.releaseLock();
  }
}

const isAborted = (signal: AbortSignal) => signal.aborted;

function retriable(error: unknown): boolean {
  if (error instanceof ApiError) return RETRY_STATUSES.has(error.status);
  // A network failure (fetch rejects with TypeError) or a connection the idle timer cut.
  return (
    error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError')
  );
}

/**
 * Reads a turn to its end, reconnecting as D120 (4) says. Resolves with how it ended and where
 * the reading stood, never rejects.
 */
export async function followTurn(options: FollowOptions): Promise<TurnEnd> {
  const sleep = options.sleep ?? abortableSleep;
  const idleMs = options.idleMs ?? IDLE_MS;
  const { signal } = options;
  let progress = options.from ?? TURN_START;
  let attempt = 0;
  for (;;) {
    if (signal.aborted) return { kind: 'aborted', progress };
    const connection = new AbortController();
    const stopConnection = () => {
      connection.abort();
    };
    signal.addEventListener('abort', stopConnection, { once: true });
    const reconnecting = attempt > 0;
    const reader = new Reader(progress, options.onProgress, () => {
      if (reconnecting) options.onConnection({ kind: 'resumed' });
    });
    let outcome: Outcome;
    try {
      const response = await options.open(progress.lastId, connection.signal);
      outcome = await readConnection(response, reader, connection.signal, idleMs, stopConnection);
    } catch (error) {
      outcome = { kind: 'error', error, fresh: false };
    } finally {
      signal.removeEventListener('abort', stopConnection);
    }
    progress = reader.progress;
    // Read again: the reading may have been stopped while this connection was open.
    if (isAborted(signal)) return { kind: 'aborted', progress };
    if (outcome.kind === 'complete') return { kind: 'complete', progress };
    if (outcome.kind === 'error') {
      const { error } = outcome;
      if (error instanceof NotAuthenticatedError) return { kind: 'unauthenticated', progress };
      if (error instanceof ApiError && error.status === 401) {
        return { kind: 'unauthenticated', progress };
      }
      if (
        error instanceof DeltaError ||
        error instanceof SseProtocolError ||
        error instanceof SyntaxError
      ) {
        return { kind: 'failed', progress, status: null, code: 'invalid_event' };
      }
      if (!retriable(error)) {
        return error instanceof ApiError
          ? { kind: 'failed', progress, status: error.status, code: error.code }
          : { kind: 'failed', progress, status: null, code: 'network' };
      }
    }
    // Something new arrived: the count of this cut starts again.
    if (outcome.fresh) attempt = 0;
    attempt += 1;
    if (attempt > MAX_ATTEMPTS) {
      return { kind: 'failed', progress, status: null, code: 'reconnect_failed' };
    }
    options.onConnection({ kind: 'reconnecting', attempt });
    await sleep(retryDelay(attempt, options.random), signal);
  }
}
