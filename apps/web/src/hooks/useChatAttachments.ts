import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import type { OperationOutput } from '../api/operations';
import {
  MAX_ATTACHMENTS,
  attachmentGate,
  newConversationId,
  statusFromServer,
  type ComposerAttachment,
} from '../components/chat/attachments';
import { postFile, type SignedPost } from '../pages/knowledge/upload';

// The attachments of the composer (D116 (11)): each batch of files is announced to mango-api,
// which signs one POST per file it takes; the browser posts each one straight to the bucket
// (progress by XHR), then asks `…/confirm` until every file is ready or says why not. The API
// decides the types, the sizes and the scans; nothing here lets a file through.

type Signed = OperationOutput<'requestChatUploads'>;
type Confirmed = OperationOutput<'confirmChatUploads'>;

/** The calls of a batch; the page uses the API's, the tests their own. */
export interface AttachmentUploader {
  request: (
    conversationId: string,
    files: { name: string; size: number }[],
    signal: AbortSignal,
  ) => Promise<Signed>;
  post: (
    post: SignedPost,
    file: File,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  confirm: (
    conversationId: string,
    uploadId: string,
    fileIds: string[],
    signal: AbortSignal,
  ) => Promise<Confirmed>;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Between two `…/confirm` while a file is scanned: well under the API's 120 per minute. */
export const SCAN_POLL_MS = 2_000;
/** The API fails a scan that does not arrive in 30 minutes; the composer stops a bit after. */
const SCAN_DEADLINE_MS = 31 * 60_000;
/** Transient failures of `…/confirm` in a row before the file says «No se pudo subir». */
const CONFIRM_ATTEMPTS = 5;

function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });
}

export function apiUploader(api: ApiClient): AttachmentUploader {
  return {
    request: (conversationId, files, signal) =>
      api.call(
        'requestChatUploads',
        { path: { conversation_id: conversationId }, body: { files } },
        { signal },
      ),
    post: postFile,
    confirm: (conversationId, uploadId, fileIds, signal) =>
      api.call(
        'confirmChatUploads',
        {
          path: { conversation_id: conversationId, upload_id: uploadId },
          body: { file_ids: fileIds },
        },
        { signal },
      ),
    wait: abortableWait,
  };
}

interface Options {
  uploader: AttachmentUploader;
  /** The conversation on screen; null for a new chat, which names its own (D116 (11)). */
  conversationId: string | null;
  /** Changes when the composer is for another chat: what was attached is dropped. */
  scope: string;
}

export function useChatAttachments({ uploader, conversationId, scope }: Options) {
  const [items, setItems] = useState<ComposerAttachment[]>([]);
  const [overflow, setOverflow] = useState(0);
  // The id a new chat uploads to and then sends its first turn with.
  const [draftId, setDraftId] = useState(newConversationId);
  const target = conversationId ?? draftId;
  // What the async work reads: which chips still exist, and their files for «Reintentar».
  const live = useRef(new Map<string, File>());
  const runRef = useRef(new AbortController());
  const uploaderRef = useRef(uploader);
  useEffect(() => {
    uploaderRef.current = uploader;
  });

  const update = useCallback((id: string, patch: Partial<ComposerAttachment>) => {
    if (!live.current.has(id)) return;
    // XHR progress fires often: the same percent keeps the list (and the composer) as it is.
    setItems((current) => {
      const index = current.findIndex((item) => item.id === id);
      const item = current[index];
      if (!item) return current;
      const changed = (Object.keys(patch) as (keyof ComposerAttachment)[]).some(
        (key) => patch[key] !== item[key],
      );
      return changed ? current.with(index, { ...item, ...patch }) : current;
    });
  }, []);

  // Another chat: stop every upload and poll, and start empty with a new draft id.
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope) {
    setSeenScope(scope);
    setItems([]);
    setOverflow(0);
    setDraftId(newConversationId());
  }
  useEffect(() => {
    const run = new AbortController();
    runRef.current = run;
    const files = live.current;
    return () => {
      run.abort();
      files.clear();
    };
  }, [scope]);

  const upload = useCallback(
    async (batch: { id: string; file: File }[], conversation: string) => {
      const { signal } = runRef.current;
      // Read as a call: the batch outlives awaits that may abort it.
      const stopped = () => signal.aborted;
      const calls = uploaderRef.current;
      const fail = (ids: string[]) => {
        for (const id of ids) update(id, { status: 'failed' });
      };
      // An empty file has nothing to upload: the API takes 1 byte or more.
      const empty = batch.filter((entry) => entry.file.size < 1);
      fail(empty.map((entry) => entry.id));
      const announced = batch.filter((entry) => entry.file.size >= 1);
      if (announced.length === 0) return;
      let signed: Signed;
      try {
        signed = await calls.request(
          conversation,
          announced.map((entry) => ({ name: entry.file.name, size: entry.file.size })),
          signal,
        );
      } catch {
        if (!signal.aborted) fail(announced.map((entry) => entry.id));
        return;
      }
      const posted: { id: string; fileId: string }[] = [];
      await Promise.all(
        signed.files.map(async (file, index) => {
          const entry = announced[index];
          if (!entry) return;
          if (file.status !== 'uploading' || !file.url || !file.fields || !file.file_id) {
            update(entry.id, {
              status: file.status === 'too_large' ? 'too_large' : 'unsupported',
            });
            return;
          }
          const fileId = file.file_id;
          update(entry.id, { fileId });
          try {
            await calls.post(
              { url: file.url, fields: file.fields },
              entry.file,
              (fraction) => {
                update(entry.id, { percent: Math.min(99, Math.round(fraction * 100)) });
              },
              signal,
            );
          } catch {
            if (!signal.aborted) update(entry.id, { status: 'failed' });
            return;
          }
          update(entry.id, { status: 'scanning', percent: 100 });
          posted.push({ id: entry.id, fileId });
        }),
      );
      // «Revisando el archivo…»: each call takes the files as far as their scans allow.
      let pending = posted;
      const deadline = Date.now() + SCAN_DEADLINE_MS;
      let delay = 0;
      let errors = 0;
      while (pending.length > 0 && !signal.aborted) {
        if (delay > 0) {
          try {
            await calls.wait(delay, signal);
          } catch {
            return;
          }
        }
        pending = pending.filter((entry) => live.current.has(entry.id));
        if (pending.length === 0) return;
        if (Date.now() > deadline) {
          fail(pending.map((entry) => entry.id));
          return;
        }
        let confirmed: Confirmed;
        try {
          confirmed = await calls.confirm(
            conversation,
            signed.upload_id,
            pending.map((entry) => entry.fileId),
            signal,
          );
        } catch (error) {
          if (stopped()) return;
          errors += 1;
          const retryAfter = error instanceof ApiError ? error.retryAfter : null;
          const lasting = error instanceof ApiError && error.status === 404;
          if (lasting || errors >= CONFIRM_ATTEMPTS) {
            fail(pending.map((entry) => entry.id));
            return;
          }
          delay = retryAfter !== null ? retryAfter * 1000 : SCAN_POLL_MS * errors;
          continue;
        }
        errors = 0;
        const byId = new Map(confirmed.files.map((file) => [file.file_id, file]));
        pending = pending.filter((entry) => {
          const file = byId.get(entry.fileId);
          const status = file ? statusFromServer(file.status) : 'failed';
          update(entry.id, { status });
          return status === 'scanning';
        });
        delay = SCAN_POLL_MS;
      }
    },
    [update],
  );

  /** Design `crAddFiles`: up to 20 per message; the rest are counted in the note. */
  const add = useCallback(
    (files: readonly File[]) => {
      const room = Math.max(0, MAX_ATTACHMENTS - live.current.size);
      const taken = files.slice(0, room);
      setOverflow(files.length - taken.length);
      if (taken.length === 0) return;
      const batch = taken.map((file) => ({ id: crypto.randomUUID(), file }));
      for (const entry of batch) live.current.set(entry.id, entry.file);
      setItems((current) => [
        ...current,
        ...batch.map(({ id, file }): ComposerAttachment => ({
          id,
          name: file.name,
          size: file.size,
          status: 'uploading',
          percent: 0,
          fileId: null,
        })),
      ]);
      void upload(batch, target);
    },
    [target, upload],
  );

  const remove = useCallback((id: string) => {
    live.current.delete(id);
    setOverflow(0);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  /** «Reintentar» a file that did not upload: announced again, as a batch of one. */
  const retry = useCallback(
    (id: string) => {
      const file = live.current.get(id);
      if (!file) return;
      update(id, { status: 'uploading', percent: 0, fileId: null });
      void upload([{ id, file }], target);
    },
    [target, update, upload],
  );

  /** The message went out with its files: the composer starts empty again. */
  const clear = useCallback(() => {
    live.current.clear();
    setItems([]);
    setOverflow(0);
  }, []);

  /** A message that did not go out comes back with the files it had (all of them ready). */
  const restore = useCallback((sent: readonly ComposerAttachment[]) => {
    live.current.clear();
    for (const item of sent) live.current.set(item.id, new File([], item.name));
    setItems([...sent]);
    setOverflow(0);
  }, []);

  const gate = useMemo(() => attachmentGate(items), [items]);
  return { items, overflow, gate, conversationId: target, add, remove, retry, clear, restore };
}
