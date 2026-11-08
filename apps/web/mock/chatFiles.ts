/**
 * The files of the chat in the mock (D116 (11)): `POST /api/conversations/{id}/uploads` signs
 * one "POST" per file to the mock bucket (`/mock-s3/chat/{upload}/{file}`), `…/confirm` follows
 * a scan that takes a moment, and a turn takes only ready files of its conversation.
 *
 * Demo variants of the design (round 40, `simAttach`), by a word of the file name: «bloqueado»
 * is blocked by the scan, «disfrazado» is not the type it says, and «falla» fails its first
 * upload (its «Reintentar» works). Types and sizes are the server's, as in mango-api.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { newId, readObject, sendError, sendJson } from './http.ts';

const MAX_FILES = 20;
const MAX_BYTES = 100 * 1024 * 1024;
const KINDS = new Set(['pdf', 'csv', 'txt', 'json', 'xlsx', 'docx', 'pptx', 'png', 'jpg', 'jpeg']);
/** How long «Revisando el archivo…» lasts once the file arrived. */
const SCAN_MS = 1_500;
const UPLOAD_MS = 15 * 60_000;
const RETENTION_MS = 90 * 24 * 3_600_000;
const CONVERSATION_ID = /^[0-9a-f]{32}$/;
const FILE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

type Status = 'uploading' | 'scanning' | 'ready' | 'blocked' | 'type_mismatch' | 'failed';

interface MockChatFile {
  fileId: string;
  uploadId: string;
  conversationId: string;
  name: string;
  kind: string;
  size: number;
  createdAt: number;
  /** When the bucket took it; null while it was not posted. */
  arrivedAt: number | null;
}

const files = new Map<string, MockChatFile>();
/** Names whose first upload already failed («falla»), so «Reintentar» goes through. */
const failedOnce = new Set<string>();

const kindOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  const kind = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return KINDS.has(kind) ? kind : null;
};

function statusOf(file: MockChatFile, now: number): Status {
  if (file.arrivedAt === null) return now - file.createdAt > UPLOAD_MS ? 'failed' : 'uploading';
  if (now - file.arrivedAt < SCAN_MS) return 'scanning';
  if (/bloqueado/i.test(file.name)) return 'blocked';
  if (/disfrazado/i.test(file.name)) return 'type_mismatch';
  return 'ready';
}

function attachmentOut(file: MockChatFile, now: number) {
  return {
    file_id: file.fileId,
    name: file.name,
    kind: file.kind,
    size_bytes: file.size,
    origin: 'upload' as const,
    status: statusOf(file, now),
    expires_at: new Date(file.createdAt + RETENTION_MS).toISOString(),
    gone: false,
  };
}

/** What a stored question keeps of each file (`MessageOut.attachments`). */
export interface StoredAttachment {
  file_id: string;
  name: string;
  kind: string;
  size_bytes: number;
  gone: boolean;
}

/**
 * The files of a turn (TM-CF9): uploads of this conversation, ready. The API's answers: 404
 * `unknown_attachment` for one that is not of it, 422 `attachment_not_ready` otherwise.
 */
export function turnAttachments(
  conversationId: string,
  ids: readonly unknown[],
): StoredAttachment[] | { status: number; code: string } {
  const now = Date.now();
  const out: StoredAttachment[] = [];
  for (const id of new Set(ids)) {
    const file = typeof id === 'string' ? files.get(id) : undefined;
    if (!file || file.conversationId !== conversationId) {
      return { status: 404, code: 'unknown_attachment' };
    }
    if (statusOf(file, now) !== 'ready') return { status: 422, code: 'attachment_not_ready' };
    out.push({
      file_id: file.fileId,
      name: file.name,
      kind: file.kind,
      size_bytes: file.size,
      gone: false,
    });
  }
  return out;
}

async function sign(req: IncomingMessage, res: ServerResponse, conversationId: string) {
  const input = await readObject(req, ['files']);
  const list = Array.isArray(input?.files) ? (input.files as unknown[]) : null;
  if (!list || list.length === 0 || list.length > MAX_FILES) {
    sendError(res, 422, 'invalid_request', 'Invalid upload request');
    return;
  }
  const now = Date.now();
  const uploadId = newId();
  const origin = `http://${req.headers.host ?? 'localhost:5173'}`;
  const out = [];
  for (const raw of list) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const size = typeof entry.size === 'number' ? entry.size : 0;
    if (!name || name.length > 1024 || !Number.isInteger(size) || size < 1) {
      sendError(res, 422, 'invalid_request', 'Invalid upload request');
      return;
    }
    const kind = kindOf(name);
    if (!kind) {
      out.push({ name, status: 'unsupported_type' });
      continue;
    }
    if (size > MAX_BYTES) {
      out.push({ name, status: 'too_large' });
      continue;
    }
    const fileId = newId();
    files.set(fileId, {
      fileId,
      uploadId,
      conversationId,
      name,
      kind,
      size,
      createdAt: now,
      arrivedAt: null,
    });
    out.push({
      name,
      status: 'uploading',
      file_id: fileId,
      url: `${origin}/mock-s3/chat/${uploadId}/${fileId}`,
      fields: { key: `uploads/mock/${uploadId}/${fileId}` },
    });
  }
  sendJson(res, 201, {
    upload_id: uploadId,
    expires_at: new Date(now + UPLOAD_MS).toISOString(),
    files: out,
  });
}

async function confirm(
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
  uploadId: string,
) {
  const input = await readObject(req, ['file_ids']);
  const ids = Array.isArray(input?.file_ids) ? (input.file_ids as unknown[]) : null;
  if (!ids || ids.length === 0 || ids.length > MAX_FILES) {
    sendError(res, 422, 'invalid_request', 'Invalid confirm request');
    return;
  }
  const now = Date.now();
  const out = [];
  for (const id of new Set(ids)) {
    const file = typeof id === 'string' ? files.get(id) : undefined;
    if (!file || file.uploadId !== uploadId || file.conversationId !== conversationId) {
      sendError(res, 404, 'unknown_file', 'a file is not of this upload');
      return;
    }
    // Like the API: a file that never arrived waits for a scan that will not come.
    out.push(
      file.arrivedAt === null
        ? { ...attachmentOut(file, now), status: 'scanning' }
        : attachmentOut(file, now),
    );
  }
  sendJson(res, 200, { files: out });
}

const S3_ROUTE = /^\/mock-s3\/chat\/([0-9A-Z]{26})\/([0-9A-Z]{26})$/;

/** The mock bucket of the chat: like S3 it needs no session, only a file it signed. */
export async function handleChatFilesS3(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  const match = S3_ROUTE.exec(path);
  if (!match || req.method !== 'POST') return false;
  const [, uploadId = '', fileId = ''] = match;
  const file = files.get(fileId);
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BYTES + 64 * 1024) break;
  }
  const late = file ? Date.now() - file.createdAt > UPLOAD_MS : true;
  if (!file || file.uploadId !== uploadId || late || size > MAX_BYTES + 64 * 1024) {
    res.statusCode = 403;
    res.end();
    return true;
  }
  if (/falla/i.test(file.name) && !failedOnce.has(file.name)) {
    failedOnce.add(file.name);
    res.statusCode = 500;
    res.end();
    return true;
  }
  file.arrivedAt = Date.now();
  res.statusCode = 204;
  res.end();
  return true;
}

const UPLOADS = /^\/conversations\/([0-9a-f]{32})\/uploads$/;
const CONFIRM = /^\/conversations\/([0-9a-f]{32})\/uploads\/([0-9A-Z]{26})\/confirm$/;

/**
 * The routes of the chat's files. A new chat uploads to the id it will start with (D116 (11)),
 * so any well-formed id is taken.
 */
export async function handleChatFiles(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  const upload = UPLOADS.exec(path);
  if (upload && CONVERSATION_ID.test(upload[1] ?? '')) {
    await sign(req, res, upload[1] ?? '');
    return true;
  }
  const confirmed = CONFIRM.exec(path);
  if (confirmed && FILE_ID.test(confirmed[2] ?? '')) {
    await confirm(req, res, confirmed[1] ?? '', confirmed[2] ?? '');
    return true;
  }
  return false;
}
