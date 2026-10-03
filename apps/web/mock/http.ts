/** HTTP helpers shared by the mock domains (dev server only). */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 16 * 1024;

/**
 * One domain of the mock API. `path` has no `/api` prefix. Returns false when the route is not
 * its own, so the next domain is tried.
 */
export type ApiHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
) => Promise<boolean>;

export function newId(): string {
  // ULID-like public ID: random, never incremental.
  return `01${randomBytes(12).toString('hex').toUpperCase()}`;
}

export function originOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? 'localhost:5173'}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  sendJson(res, status, { error: { code, message } });
}

export function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

export async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parses a JSON object body and checks it has exactly `keys` (extra="forbid"). */
export async function readObject(
  req: IncomingMessage,
  keys: string[],
): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const actual = Object.keys(record).sort().join(',');
  return actual === [...keys].sort().join(',') ? record : null;
}
