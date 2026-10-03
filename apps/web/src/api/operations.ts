import { operations, type OperationId } from '@mango/api-client/operations';
import type { z } from 'zod';

import { ApiError } from './errors';

// Typed access to every JSON route of mango-api through the generated operation table
// (packages/ts/api-client, D38). Nothing here is written per endpoint: after `mise run api-client`
// a new route can be called by its name. Path parameters, query and body are validated with the
// generated schemas before the request, and the response after it, because API data is untrusted
// input for the renderer.

type Operations = typeof operations;

type Required_<Key extends string, Schema> = Schema extends z.ZodType
  ? Record<Key, z.input<Schema>>
  : Partial<Record<Key, never>>;

type Query<Schema> = Schema extends z.ZodType
  ? Record<string, never> extends z.input<Schema>
    ? { query?: z.input<Schema> }
    : { query: z.input<Schema> }
  : { query?: never };

export type OperationInput<Id extends OperationId> = Required_<
  'path',
  Operations[Id]['pathParams']
> &
  Query<Operations[Id]['query']> &
  Required_<'body', Operations[Id]['body']>;

export type OperationOutput<Id extends OperationId> = z.output<Operations[Id]['response']>;

export interface CallOptions {
  signal?: AbortSignal;
}

/** `input` is optional only when the operation takes no path parameters and no body. */
type CallArgs<Id extends OperationId> =
  Record<string, never> extends OperationInput<Id>
    ? [input?: OperationInput<Id>, options?: CallOptions]
    : [input: OperationInput<Id>, options?: CallOptions];

export type OperationCaller = <Id extends OperationId>(
  id: Id,
  ...args: CallArgs<Id>
) => Promise<OperationOutput<Id>>;

interface OperationSpec {
  method: string;
  path: string;
  pathParams: z.ZodType | null;
  query: z.ZodType | null;
  body: z.ZodType | null;
  response: z.ZodType;
}

interface LooseInput {
  path?: unknown;
  query?: unknown;
  body?: unknown;
}

function invalid(id: string, part: string): ApiError {
  return new ApiError(422, 'invalid_request', `Invalid ${part} for ${id}`);
}

function parsed(id: string, part: string, schema: z.ZodType, value: unknown): unknown {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid(id, part);
  return result.data;
}

/** Fills `{name}` placeholders with validated, percent-encoded values. */
function buildPath(id: string, spec: OperationSpec, input: LooseInput): string {
  if (!spec.pathParams) return spec.path;
  const values = new Map(
    Object.entries(parsed(id, 'path', spec.pathParams, input.path) as Record<string, unknown>),
  );
  return spec.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = values.get(name);
    if (typeof value !== 'string' && typeof value !== 'number') throw invalid(id, 'path');
    return encodeURIComponent(String(value));
  });
}

function buildQuery(id: string, spec: OperationSpec, input: LooseInput): string {
  if (!spec.query) return '';
  const values = parsed(id, 'query', spec.query, input.query ?? {}) as Record<string, unknown>;
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? (value as unknown[]) : [value]) {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        query.append(name, String(item));
      } else if (item !== null && item !== undefined) {
        throw invalid(id, 'query');
      }
    }
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

export function createOperationCaller(
  authorizedFetch: (path: string, init?: RequestInit) => Promise<Response>,
): OperationCaller {
  return async (id, ...args) => {
    const spec: OperationSpec = operations[id];
    const [input = {}, options = {}] = args as [LooseInput?, CallOptions?];
    const url = buildPath(id, spec, input) + buildQuery(id, spec, input);
    const headers: Record<string, string> = { Accept: 'application/json' };
    const init: RequestInit = { method: spec.method, headers };
    if (spec.body) {
      headers['Content-Type'] = 'application/json';
      // zod objects drop unknown keys: only the fields of the contract are sent.
      init.body = JSON.stringify(parsed(id, 'body', spec.body, input.body));
    }
    if (options.signal) init.signal = options.signal;
    const response = await authorizedFetch(url, init);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      data = undefined;
    }
    const result = spec.response.safeParse(data);
    if (!result.success) {
      throw new ApiError(response.status, 'invalid_response', 'Unexpected response from the API');
    }
    return result.data as never;
  };
}
