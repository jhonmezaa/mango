/**
 * Directory lookups to share an agent with people (POST /api/directory/users/resolve): emails
 * to user identifiers and back. The mock directory has usuario1–9@empresa.com, as the design.
 */
import { recordAudit } from './audit.ts';
import { readBody, sendError, sendJson, type ApiHandler } from './http.ts';

const MAX_EMAILS = 20;
const MAX_IDS = 50;
const EMAIL_PATTERN = /^[^@\s"\\]{1,64}@[^@\s"\\]{1,253}$/;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** `usuarioN@empresa.com` <-> a fixed identifier shaped like a Cognito `sub`. */
const DIRECTORY = new Map(
  Array.from({ length: 9 }, (_, index) => [
    `usuario${index + 1}@empresa.com`,
    `00000000-0000-4000-8000-00000000000${index + 1}`,
  ]),
);

function strings(value: unknown, max: number, pattern: RegExp): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const items = value.map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''));
  return items.every((item) => pattern.test(item)) ? [...new Set(items)] : null;
}

export const handleDirectory: ApiHandler = async (req, res, path) => {
  if (path !== '/directory/users/resolve' || req.method !== 'POST') return false;
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    body = null;
  }
  const record =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const known = record !== null && Object.keys(record).every((k) => k === 'emails' || k === 'ids');
  const emails = known ? strings(record.emails, MAX_EMAILS, EMAIL_PATTERN) : null;
  // Identifiers keep their case; only emails are normalized.
  const ids =
    known && (record.ids === undefined || Array.isArray(record.ids))
      ? ((record.ids as unknown[] | undefined) ?? [])
      : null;
  if (
    emails === null ||
    ids === null ||
    ids.length > MAX_IDS ||
    !ids.every((id): id is string => typeof id === 'string' && ID_PATTERN.test(id)) ||
    emails.length + ids.length === 0
  ) {
    sendError(res, 422, 'invalid_request', 'invalid fields: body');
    return true;
  }
  const users = new Map<string, string>();
  const emailsNotFound: string[] = [];
  const idsNotFound: string[] = [];
  for (const email of emails) {
    const id = DIRECTORY.get(email);
    if (id) users.set(id, email);
    else emailsNotFound.push(email);
  }
  const foundByEmail = [...users.keys()];
  for (const id of new Set(ids)) {
    const email = [...DIRECTORY].find(([, other]) => other === id)?.[0];
    if (email) users.set(id, email);
    else idsNotFound.push(id);
  }
  // Counts and the identifiers found, never the emails asked for (same as the API).
  recordAudit('directory.lookup', {
    emails: emails.length,
    ids: ids.length,
    emails_found: foundByEmail.length,
    ids_found: ids.length - idsNotFound.length,
    found_users: foundByEmail.sort(),
    outcome: 'applied',
  });
  sendJson(res, 200, {
    users: [...users].map(([id, email]) => ({ id, email })),
    emails_not_found: emailsNotFound,
    ids_not_found: idsNotFound,
  });
  return true;
};
