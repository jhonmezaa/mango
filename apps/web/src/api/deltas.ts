/**
 * Applier of the `v1` deltas of a chat turn (D120 (3)), with the rules of the reference applier
 * of the API tests (`apps/api/tests/v1_patches.py`):
 *
 * - `delta_encoding` with `"v1"` starts a connection; a delta before it is refused.
 * - `c`, `p` and `o` are inherited from the previous delta of the connection, `v` never. The
 *   first delta starts from `{c: 0, p: "", o: "add"}`.
 * - Each channel is a JSON document of its own. Paths are JSON Pointers (`~1`, `~0`); a numeric
 *   segment is an index; missing parents are created (`[]` before a numeric segment, `{}`
 *   otherwise); `__proto__`, `constructor` and `prototype` are refused (prototype pollution).
 * - `add`, `replace`, `remove`, `append`, `truncate` and `patch` (sub-deltas applied in order on
 *   the value at the path, without inheritance). Anything else is refused.
 * - Immutable: a delta never changes the documents it was given. One that fails leaves them as
 *   they were; one that applies returns new documents that share what did not change.
 *
 * The documents outlive a connection: a client that resumes keeps them and opens a new
 * connection with `after` = the last delta id it applied.
 *
 * Security (security-best-practices, REACT/JS prototype pollution): the paths come from the
 * server, the values from the model through it. Values are only ever data: nothing here
 * evaluates them, and objects are built with spread / `Object.fromEntries`, never with
 * `Object.assign` or a plain `target[key] = value` on a shared object.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Operation = 'add' | 'replace' | 'remove' | 'append' | 'truncate' | 'patch';

const OPERATIONS: ReadonlySet<string> = new Set<Operation>([
  'add',
  'replace',
  'remove',
  'append',
  'truncate',
  'patch',
]);

const UNSAFE: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const INDEX = /^(0|[1-9]\d*)$/;
/** Deepest path a delta may write: the server's paths are three segments at most. */
const MAX_SEGMENTS = 32;
/** Highest channel number accepted: one per message of a turn. */
export const MAX_CHANNEL = 10_000;

export class DeltaError extends Error {
  override name = 'DeltaError';
}

/** The channels of a turn: channel number → its document. */
export type Channels = ReadonlyMap<number, Json>;

export const NO_CHANNELS: Channels = new Map();

/** What the previous delta of the connection said, for the next one to inherit. */
export interface Inherited {
  c: number;
  p: string;
  o: Operation;
}

export const CONNECTION_START: Inherited = { c: 0, p: '', o: 'add' };

/** A delta with nothing left to inherit. */
export interface FullDelta extends Inherited {
  v: Json | undefined;
}

type Segment = string | number;

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function segmentsOf(path: string): Segment[] {
  if (path === '') return [];
  const raw = path.startsWith('/') ? path.slice(1) : path;
  const parts = raw.split('/');
  if (parts.length > MAX_SEGMENTS) throw new DeltaError('Delta path too deep');
  return parts.map((part) => {
    const segment = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (UNSAFE.has(segment)) throw new DeltaError('Unsafe delta path segment');
    return INDEX.test(segment) ? Number(segment) : segment;
  });
}

function has(node: Json | undefined, key: Segment): boolean {
  if (Array.isArray(node)) return typeof key === 'number' && key < node.length;
  if (isObject(node)) return Object.hasOwn(node, String(key));
  throw new DeltaError('Path through a value that is not a container');
}

function get(node: Json | undefined, key: Segment): Json | undefined {
  if (!has(node, key)) return undefined;
  if (Array.isArray(node)) return node[key as number];
  return (node as { [key: string]: Json })[String(key)];
}

/** `node` with `key` set to `value`, as a new container. */
function withKey(node: Json | undefined, key: Segment, value: Json): Json {
  if (Array.isArray(node)) {
    if (typeof key !== 'number') throw new DeltaError('Array index expected');
    if (key > node.length) throw new DeltaError('Array index out of range');
    const next = [...node];
    next[key] = value;
    return next;
  }
  if (!isObject(node)) throw new DeltaError('Path through a value that is not a container');
  return { ...node, [String(key)]: value };
}

/** `node` without `key`, as a new container. */
function withoutKey(node: Json | undefined, key: Segment): Json | undefined {
  if (Array.isArray(node)) {
    if (typeof key !== 'number') throw new DeltaError('Array index expected');
    if (key >= node.length) return node;
    return [...node.slice(0, key), ...node.slice(key + 1)];
  }
  if (!isObject(node)) throw new DeltaError('Path through a value that is not a container');
  if (!Object.hasOwn(node, String(key))) return node;
  return Object.fromEntries(Object.entries(node).filter(([name]) => name !== String(key)));
}

/** The new value at the end of the path, given the current one. */
function operate(
  parent: Json | undefined,
  key: Segment,
  op: Operation,
  value: Json | undefined,
): { set: Json } | { remove: true } | { insert: Json } {
  const current = get(parent, key);
  switch (op) {
    case 'add':
      if (value === undefined) throw new DeltaError('add takes a value');
      return Array.isArray(parent) && typeof key === 'number' ? { insert: value } : { set: value };
    case 'replace':
      if (value === undefined) throw new DeltaError('replace takes a value');
      return { set: value };
    case 'remove':
      return { remove: true };
    case 'append':
      if (value === undefined) throw new DeltaError('append takes a value');
      if (typeof current === 'string' && typeof value === 'string') return { set: current + value };
      if (Array.isArray(current)) {
        return { set: [...current, ...(Array.isArray(value) ? value : [value])] };
      }
      if (isObject(current) && isObject(value)) {
        for (const name of Object.keys(value)) {
          if (UNSAFE.has(name)) throw new DeltaError('Unsafe delta path segment');
        }
        return { set: { ...current, ...value } };
      }
      return { set: value };
    case 'truncate': {
      const length = Number(value);
      if (!Number.isInteger(length) || length < 0) throw new DeltaError('truncate takes a length');
      if (typeof current === 'string') return { set: current.slice(0, length) };
      if (Array.isArray(current)) return { set: current.slice(0, length) };
      return current === undefined ? { remove: true } : { set: current };
    }
    case 'patch':
      throw new DeltaError('patch is applied by its sub-deltas');
  }
}

/** `node` with the operation applied at `segments`, creating the parents that are missing. */
function applyAt(
  node: Json | undefined,
  segments: readonly Segment[],
  op: Operation,
  value: Json | undefined,
): Json | undefined {
  const [key, ...rest] = segments;
  if (key === undefined) throw new DeltaError('Empty path');
  if (rest.length > 0) {
    const child = get(node, key);
    const base = child ?? (typeof rest[0] === 'number' ? [] : {});
    const next = applyAt(base, rest, op, value);
    return withKey(node, key, next ?? null);
  }
  const outcome = operate(node, key, op, value);
  if ('remove' in outcome) return withoutKey(node, key);
  if ('insert' in outcome && Array.isArray(node) && typeof key === 'number') {
    if (key > node.length) throw new DeltaError('Array index out of range');
    return [...node.slice(0, key), outcome.insert, ...node.slice(key)];
  }
  return withKey(node, key, 'set' in outcome ? outcome.set : outcome.insert);
}

const ROOT = '__root';

/** The document after one operation (or a patch of them) at `path`. */
function applyOperation(
  document: Json | undefined,
  path: string,
  op: Operation,
  value: Json | undefined,
): Json | undefined {
  if (op === 'patch') {
    if (!Array.isArray(value)) throw new DeltaError('patch takes a list');
    let next = document;
    for (const sub of value) {
      if (!isObject(sub) || typeof sub.o !== 'string' || !OPERATIONS.has(sub.o)) {
        throw new DeltaError('Sub-delta without a known operation');
      }
      const subPath = typeof sub.p === 'string' ? sub.p : '';
      next = applyOperation(
        next,
        subPath ? path + subPath : path,
        sub.o as Operation,
        Object.hasOwn(sub, 'v') ? sub.v : undefined,
      );
    }
    return next;
  }
  // The channel's document hangs from a root of its own, so a path of "" replaces it whole.
  const root = applyAt({ [ROOT]: document ?? null }, [ROOT, ...segmentsOf(path)], op, value);
  return isObject(root) ? root[ROOT] : undefined;
}

/**
 * Fills in what a delta inherits from the previous one of its connection (`c`, `p`, `o`, never
 * `v`) and checks its shape. Throws `DeltaError` for anything this applier refuses.
 */
export function inherit(previous: Inherited, raw: unknown): FullDelta {
  if (!isObject(raw as Json)) throw new DeltaError('A delta is an object');
  const data = raw as { [key: string]: Json };
  const c = Object.hasOwn(data, 'c') ? data.c : previous.c;
  const p = Object.hasOwn(data, 'p') ? data.p : previous.p;
  const o = Object.hasOwn(data, 'o') ? data.o : previous.o;
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > MAX_CHANNEL) {
    throw new DeltaError('Bad channel');
  }
  if (typeof p !== 'string') throw new DeltaError('Bad path');
  if (typeof o !== 'string' || !OPERATIONS.has(o)) throw new DeltaError('Unknown operation');
  const hasValue = Object.hasOwn(data, 'v');
  if (!hasValue && o !== 'remove') throw new DeltaError('v is never inherited');
  return { c, p, o: o as Operation, v: hasValue ? data.v : undefined };
}

/** The channels after one full delta, as new documents; the given ones never change. */
export function applyDelta(channels: Channels, delta: FullDelta): Channels {
  const document = applyOperation(channels.get(delta.c), delta.p, delta.o, delta.v);
  const next = new Map(channels);
  if (document === undefined) next.delete(delta.c);
  else next.set(delta.c, document);
  return next;
}

/** What a connection keeps between deltas: whether it started, and what the next inherits. */
export interface Connection {
  started: boolean;
  previous: Inherited;
}

export const NOT_STARTED: Connection = { started: false, previous: CONNECTION_START };

/** `event: delta_encoding`: only `"v1"` starts a connection; inheritance starts again. */
export function startConnection(encoding: unknown): Connection {
  if (encoding !== 'v1') throw new DeltaError('Unknown delta encoding');
  return { started: true, previous: CONNECTION_START };
}

/** One `event: delta` of a connection: the new channels and what the next delta inherits. */
export function receiveDelta(
  connection: Connection,
  channels: Channels,
  raw: unknown,
): { connection: Connection; channels: Channels } {
  if (!connection.started) throw new DeltaError('Delta before delta_encoding');
  const delta = inherit(connection.previous, raw);
  return {
    channels: applyDelta(channels, delta),
    connection: { started: true, previous: { c: delta.c, p: delta.p, o: delta.o } },
  };
}
