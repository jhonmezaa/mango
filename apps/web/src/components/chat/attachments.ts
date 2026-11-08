// The attachments of a chat message (D116, design round 40 chat-run.jsx): what each file in the
// composer is, as the API says it, and when «Enviar» may go. The list of types and the limits
// are the server's: the composer only stops at 20 files, the number the API takes per request.

import type { OperationOutput } from '../../api/operations';

/** Files per message (D116 (1)); the API refuses more in one request. */
export const MAX_ATTACHMENTS = 20;

/**
 * Where a file of the composer is (design `CR_ATT_TXT`): uploading, being scanned, ready, or
 * the reason it cannot go. `failed` («No se pudo subir») is the only one «Reintentar» fixes.
 */
export type AttachmentStatus =
  | 'uploading'
  | 'scanning'
  | 'ready'
  | 'blocked'
  | 'unsupported'
  | 'mismatch'
  | 'too_large'
  | 'failed';

export interface ComposerAttachment {
  /** Local id of the chip; the API's `file_id` comes once the file is announced. */
  id: string;
  name: string;
  size: number;
  status: AttachmentStatus;
  /** 0 to 100 while uploading. */
  percent: number;
  fileId: string | null;
}

/** A file of a message on screen: what was sent, or what the history says (`gone`). */
export interface MessageAttachment {
  fileId: string;
  name: string;
  size: number;
  /** Older than 90 days or deleted with the conversation (design «Ya no disponible»). */
  gone: boolean;
}

/** The statuses that keep a message from going out until the file is removed. */
const BAD: ReadonlySet<AttachmentStatus> = new Set([
  'blocked',
  'unsupported',
  'mismatch',
  'too_large',
  'failed',
]);

export const isBadAttachment = (status: AttachmentStatus) => BAD.has(status);

/**
 * Design `crAttGate`: «Enviar» waits while a file uploads or is scanned (`busy`), and a file
 * with a problem must be removed first (`bad`).
 */
export function attachmentGate(items: readonly ComposerAttachment[]): 'busy' | 'bad' | null {
  if (items.some((item) => item.status === 'uploading' || item.status === 'scanning'))
    return 'busy';
  if (items.some((item) => BAD.has(item.status))) return 'bad';
  return null;
}

type ServerStatus = OperationOutput<'confirmChatUploads'>['files'][number]['status'];

/** A status of `…/confirm` (D116 (11)) as the composer says it. */
export function statusFromServer(status: ServerStatus): AttachmentStatus {
  switch (status) {
    case 'uploading':
    case 'scanning':
      return 'scanning';
    case 'ready':
      return 'ready';
    case 'blocked':
      return 'blocked';
    case 'type_mismatch':
      return 'mismatch';
    case 'too_large':
      return 'too_large';
    case 'failed':
      return 'failed';
  }
}

/** A conversation id as the API makes it (32 hex): a new chat names the one it uploads to. */
export function newConversationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Design `crSize`: KB below a megabyte, MB with one decimal, in the person's locale. */
export function formatFileSize(bytes: number, locale?: string): string {
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(locale)} KB`;
}
