import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../auth/useSession';
import {
  CheckIcon,
  ChevronLeftIcon,
  CloseIcon,
  DocumentIcon,
  LockIcon,
  WarnIcon,
} from '../../components/icons';
import { formatRelative } from '../../lib/format';
import {
  ACCEPT,
  LIMITS,
  checkFiles,
  fileType,
  formatBytes,
  formatCount,
  groupDocuments,
  reasonKey,
  shownLocation,
  shownStatus,
  type Document,
  type FileRefusal,
  type KnowledgeBase,
} from './model';
import { Notice, Section } from './parts';
import { postFile } from './upload';

/** Asked before leaving the upload: false keeps the person there (design `guard`). */
export type Guard = RefObject<((proceed: () => void) => boolean) | null>;
type Notify = (message: string, tone?: 'success' | 'info') => void;

const PAGE = 20;

/** Design `KbLocked`: what a tab says to someone it does not serve. */
export function Locked({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="kb-lock" role="status">
      <div className="kb-lock-t">
        <LockIcon size={14} />
        {title}
      </div>
      <div className="kb-lock-b">{children}</div>
    </div>
  );
}

function DocumentRow({
  document,
  removable,
  asking,
  onAsk,
  onRemove,
}: {
  document: Document;
  removable: boolean;
  asking: boolean;
  onAsk: (asking: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const meta = [
    formatBytes(document.size),
    document.status === 'indexed' ? formatRelative(document.created_at) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="kb-doc">
      <div className="min-w-0">
        <div className="kb-doc-n">{document.name}</div>
        <div className="kb-doc-m">{meta}</div>
      </div>
      <div className="flex items-center flex-wrap justify-end gap-2">
        {document.status === 'failed' ? (
          <span className="badge badge-red">
            {t(`knowledge.reasons.${reasonKey(document.reason)}`)}
          </span>
        ) : null}
        {document.status === 'uploaded' || document.status === 'indexing' ? (
          <span className="badge badge-blue">
            <span className="g-spin mr-[5px] h-[9px] w-[9px]" aria-hidden="true" />
            {t('knowledge.docs.indexing')}
          </span>
        ) : null}
        {document.status === 'deleting' ? (
          <span className="badge">
            <span className="g-spin mr-[5px] h-[9px] w-[9px]" aria-hidden="true" />
            {t('knowledge.docs.deleting')}
          </span>
        ) : null}
        {removable && !asking ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label={t('knowledge.docs.removeLabel', { name: document.name })}
            onClick={() => {
              onAsk(true);
            }}
          >
            {t('knowledge.docs.remove')}
          </button>
        ) : null}
      </div>
      {asking ? (
        <div className="kb-confirm">
          <span>{t('knowledge.docs.removeConfirm')}</span>
          <span className="flex items-center gap-2">
            <button type="button" className="btn btn-sm mk-danger" onClick={onRemove}>
              {t('knowledge.docs.remove')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                onAsk(false);
              }}
            >
              {t('knowledge.docs.cancel')}
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

interface DocsProps {
  kb: KnowledgeBase;
  /** Null while they load or when they could not be read. */
  documents: readonly Document[] | null;
  documentsFailed: boolean;
  uploading: boolean;
  setUploading: (uploading: boolean) => void;
  guardRef: Guard;
  notify: Notify;
  messageOf: (error: unknown) => string;
  onRetry: () => void;
  /** Reads the documents and the list again after a change. */
  onChanged: () => Promise<void>;
}

/** «Documentos» (design `KbDocsTab`): what the knowledge base holds, and the upload. */
export function DocumentsTab({
  kb,
  documents,
  documentsFailed,
  uploading,
  setUploading,
  guardRef,
  notify,
  messageOf,
  onRetry,
  onChanged,
}: DocsProps) {
  const { t } = useTranslation();
  const { api } = useSession();
  const [shown, setShown] = useState(PAGE);
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!kb.can_view_documents) {
    return (
      <Locked title={t('knowledge.docs.lockedTitle')}>
        {t('knowledge.docs.locked', { groups: kb.groups.join(', ') })}
      </Locked>
    );
  }
  const status = shownStatus(kb);
  const upload = kb.origin === 'upload';
  const edit = kb.can_edit && status !== 'deleting';
  if (uploading && upload && edit) {
    return (
      <Upload
        kb={kb}
        guardRef={guardRef}
        notify={notify}
        messageOf={messageOf}
        onSaved={onChanged}
        onBack={() => {
          setUploading(false);
        }}
      />
    );
  }

  const remove = async (document: Document) => {
    setAsking(null);
    setError(null);
    try {
      await api.call('deleteKnowledgeBaseDocument', {
        path: { kb_id: kb.kb_id, doc_id: document.doc_id },
        body: {},
      });
      notify(t('knowledge.toast.removing', { name: document.name }), 'info');
      await onChanged();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const groups = groupDocuments(documents ?? []);
  const location = shownLocation(kb);
  const row = (document: Document, removable: boolean) => (
    <DocumentRow
      key={document.doc_id}
      document={document}
      removable={removable}
      asking={asking === document.doc_id}
      onAsk={(on) => {
        setAsking(on ? document.doc_id : null);
      }}
      onRemove={() => {
        void remove(document);
      }}
    />
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="mk-meta">
          {t('knowledge.docs.counts', {
            documents: formatCount(kb.documents),
            bytes: formatBytes(kb.bytes),
          })}
        </span>
        {upload && edit ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setUploading(true);
            }}
          >
            {t('knowledge.docs.upload')}
          </button>
        ) : null}
      </div>
      {!upload ? (
        <Notice tone="info">
          <span className="[overflow-wrap:anywhere]">
            {location
              ? t('knowledge.docs.fromBucket', { location })
              : t('knowledge.docs.fromBucketNoLocation')}
          </span>
        </Notice>
      ) : null}
      {error ? (
        <div className="kb-err" role="alert">
          {error}
        </div>
      ) : null}
      {documentsFailed ? (
        <div className="flex items-center gap-2">
          <span className="mk-meta">{t('knowledge.docs.loadError')}</span>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            {t('knowledge.docs.retry')}
          </button>
        </div>
      ) : null}
      {documents !== null && documents.length === 0 ? (
        <div className="mk-meta">
          {upload
            ? t('knowledge.docs.noneUpload')
            : status === 'approval'
              ? t('knowledge.docs.noneApproval')
              : t('knowledge.docs.noneBucket')}
        </div>
      ) : null}
      {groups.failed.length > 0 ? (
        <Section title={t('knowledge.docs.failed', { count: groups.failed.length })}>
          {groups.failed.map((document) => row(document, edit && upload))}
          <div className="mk-meta mt-1">
            {upload ? t('knowledge.docs.failedHelpUpload') : t('knowledge.docs.failedHelpBucket')}
          </div>
        </Section>
      ) : null}
      {groups.busy.length > 0 ? (
        <Section title={t('knowledge.docs.busy', { count: groups.busy.length })}>
          {groups.busy.map((document) => row(document, false))}
        </Section>
      ) : null}
      {groups.indexed.length > 0 ? (
        <Section title={t('knowledge.docs.indexed', { count: groups.indexed.length })}>
          {groups.indexed.slice(0, shown).map((document) => row(document, edit && upload))}
          {groups.indexed.length > shown ? (
            <button
              type="button"
              className="btn btn-sm mt-1.5 self-start"
              onClick={() => {
                setShown((value) => value + PAGE);
              }}
            >
              {t('knowledge.docs.more')}
            </button>
          ) : null}
        </Section>
      ) : null}
      {documents !== null && documents.length > 0 ? (
        <div className="mk-meta">{t('knowledge.docs.noDownload')}</div>
      ) : null}
    </>
  );
}

interface PendingFile {
  key: string;
  name: string;
  size: number;
  state: 'uploading' | 'uploaded' | 'rejected';
  /** Text of why it was refused (already translated). */
  reason: string | null;
  fraction: number;
  uploadId: string | null;
  docId: string | null;
}

function Upload({
  kb,
  guardRef,
  notify,
  messageOf,
  onSaved,
  onBack,
}: {
  kb: KnowledgeBase;
  guardRef: Guard;
  notify: Notify;
  messageOf: (error: unknown) => string;
  onSaved: () => Promise<void>;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { api } = useSession();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [drag, setDrag] = useState(false);
  const [trimmed, setTrimmed] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Files the server refused when saving (design `srvRej`): they stay with their reason. */
  const [serverRejected, setServerRejected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const filesRef = useRef(files);
  const keyRef = useRef(0);
  // Created by the effect: a controller made once and aborted by an earlier cleanup (StrictMode
  // mounts twice) would cancel every later upload.
  const aborts = useRef<AbortController | null>(null);
  // Read by the guard, which runs outside of a render.
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    const controller = new AbortController();
    aborts.current = controller;
    guardRef.current = (proceed) => {
      if (!filesRef.current.some((file) => file.state === 'uploaded')) return true;
      setLeaving(() => proceed);
      return false;
    };
    return () => {
      guardRef.current = null;
      controller.abort();
    };
  }, [guardRef]);

  const uploaded = files.filter((file) => file.state === 'uploaded');
  const going = files.filter((file) => file.state === 'uploading');
  const busyKb = shownStatus(kb) === 'syncing';

  const patch = (key: string, change: Partial<PendingFile>) => {
    setFiles((current) =>
      current.map((file) => (file.key === key ? { ...file, ...change } : file)),
    );
  };

  const add = async (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    setError(null);
    setServerRejected(0);
    setTrimmed(picked.length > LIMITS.batch);
    const batch = picked.slice(0, LIMITS.batch);
    const waiting = filesRef.current.filter((file) => file.state !== 'rejected');
    const refusals = checkFiles(
      batch,
      kb.documents + waiting.length,
      kb.bytes + waiting.reduce((sum, file) => sum + file.size, 0),
    );
    const rows: PendingFile[] = batch.map((file, index) => {
      const refusal: FileRefusal | null = refusals[index] ?? null;
      keyRef.current += 1;
      return {
        key: `f${String(keyRef.current)}`,
        name: file.name,
        size: file.size,
        state: refusal ? 'rejected' : 'uploading',
        reason: refusal ? t(`knowledge.upload.refusals.${refusal}`) : null,
        fraction: 0,
        uploadId: null,
        docId: null,
      };
    });
    setFiles((current) => [...current, ...rows]);
    const accepted = batch
      .map((file, index) => ({ file, row: rows[index] }))
      .filter((item): item is { file: File; row: PendingFile } => item.row?.state === 'uploading');
    if (!accepted.length) return;
    let signed;
    try {
      signed = await api.call('requestDocumentUploads', {
        path: { kb_id: kb.kb_id },
        body: {
          files: accepted.map(({ file }) => ({
            name: file.name,
            size: file.size,
            content_type: fileType(file.name) ?? '',
          })),
        },
      });
    } catch (failure) {
      const reason = messageOf(failure);
      for (const { row } of accepted) patch(row.key, { state: 'rejected', reason });
      return;
    }
    const { upload_id: uploadId } = signed;
    const signal = aborts.current?.signal ?? AbortSignal.abort();
    await Promise.all(
      accepted.map(async ({ file, row }, index) => {
        const post = signed.files[index];
        if (!post) {
          patch(row.key, { state: 'rejected', reason: t('knowledge.upload.refusals.failed') });
          return;
        }
        patch(row.key, { uploadId, docId: post.doc_id });
        try {
          await postFile(
            post,
            file,
            (fraction) => {
              patch(row.key, { fraction });
            },
            signal,
          );
          patch(row.key, { state: 'uploaded', fraction: 1 });
        } catch {
          if (signal.aborted) return;
          patch(row.key, { state: 'rejected', reason: t('knowledge.upload.refusals.failed') });
        }
      }),
    );
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setServerRejected(0);
    const byUpload = new Map<string, PendingFile[]>();
    for (const file of uploaded) {
      if (!file.uploadId || !file.docId) continue;
      byUpload.set(file.uploadId, [...(byUpload.get(file.uploadId) ?? []), file]);
    }
    let saved = 0;
    const refused = new Map<string, string>();
    try {
      for (const [uploadId, group] of byUpload) {
        const answer = await api.call('saveUploadedDocuments', {
          path: { kb_id: kb.kb_id },
          body: { upload_id: uploadId, doc_ids: group.map((file) => file.docId ?? '') },
        });
        saved += answer.saved.length;
        for (const item of answer.rejected) refused.set(item.doc_id, item.reason);
      }
    } catch (failure) {
      setError(messageOf(failure));
    }
    setSaving(false);
    if (saved > 0) notify(t('knowledge.toast.saved', { count: saved }), 'success');
    // What the server refused stays here with its reason; what it saved leaves the list.
    setFiles((current) =>
      current.flatMap((file) => {
        if (file.state !== 'uploaded' || !file.docId) return [file];
        const reason = refused.get(file.docId);
        if (reason)
          return [
            {
              ...file,
              state: 'rejected' as const,
              reason: t(`knowledge.reasons.${reasonKey(reason)}`),
            },
          ];
        return saved > 0 ? [] : [file];
      }),
    );
    setServerRejected(refused.size);
    await onSaved().catch(() => undefined);
    if (saved > 0 && refused.size === 0) onBack();
  };

  const back = () => {
    if (guardRef.current && !guardRef.current(onBack)) return;
    onBack();
  };

  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost sc-res-back self-start" onClick={back}>
        <ChevronLeftIcon size={12} />
        {t('knowledge.upload.back')}
      </button>
      <div className="sc-res-h">{t('knowledge.upload.title')}</div>
      <div
        className={drag ? 'kb-drop is-drag' : 'kb-drop'}
        onDragOver={(event) => {
          event.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => {
          setDrag(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDrag(false);
          void add(event.dataTransfer.files);
        }}
      >
        <DocumentIcon size={18} />
        <div>
          {t('knowledge.upload.drop')}{' '}
          <button
            type="button"
            className="sr-link kb-pick"
            onClick={() => {
              input.current?.click();
            }}
          >
            {t('knowledge.upload.pick')}
          </button>
        </div>
        <div className="mk-meta">{t('knowledge.upload.types')}</div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={ACCEPT}
          data-testid="kb-file-input"
          onChange={(event) => {
            void add(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
      <div className="mk-meta">
        {t('knowledge.upload.counts', {
          documents: formatCount(kb.documents),
          bytes: formatBytes(kb.bytes),
        })}
      </div>
      {trimmed ? <Notice tone="amber">{t('knowledge.upload.trimmed')}</Notice> : null}
      {files.length > 0 ? (
        <div className="kb-files" aria-live="polite">
          {files.map((file) => (
            <div key={file.key} className="kb-file">
              <DocumentIcon size={14} className="text-muted" />
              <div className="min-w-0">
                <div className="kb-file-n">{file.name}</div>
                <div className="kb-file-s">
                  {file.state === 'uploading' ? (
                    <>
                      <span className="mk-bar-track">
                        <span
                          style={{
                            width: `${String(Math.round(file.fraction * 100))}%`,
                            background: 'var(--blue)',
                          }}
                        />
                      </span>
                      <span>
                        {t('knowledge.upload.uploading', {
                          percent: Math.round(file.fraction * 100),
                        })}
                      </span>
                    </>
                  ) : file.state === 'uploaded' ? (
                    <span className="kb-ok">
                      <CheckIcon size={11} />
                      {t('knowledge.upload.uploaded', { size: formatBytes(file.size) })}
                    </span>
                  ) : (
                    <span className="kb-bad">
                      {t('knowledge.upload.rejected', { reason: file.reason ?? '' })}
                    </span>
                  )}
                </div>
              </div>
              {file.state !== 'uploading' ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={t('knowledge.upload.removeLabel', { name: file.name })}
                  onClick={() => {
                    setFiles((current) => current.filter((item) => item.key !== file.key));
                  }}
                >
                  <CloseIcon size={12} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {serverRejected > 0 ? (
        <div className="mc-alert amber" role="alert">
          <WarnIcon size={14} />
          <div>{t('knowledge.upload.serverRejected', { count: serverRejected })}</div>
        </div>
      ) : null}
      {leaving ? (
        <div className="mc-alert amber" role="alert">
          <WarnIcon size={14} />
          <div className="flex-1">
            {t('knowledge.upload.leaving', { count: uploaded.length })}
            <div className="flex items-center mt-2 flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const proceed = leaving;
                  filesRef.current = [];
                  setFiles([]);
                  setLeaving(null);
                  proceed();
                }}
              >
                {t('knowledge.upload.leave')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setLeaving(null);
                }}
              >
                {t('knowledge.upload.stay')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="kb-err" role="alert">
          {error}
        </div>
      ) : null}
      <div className="kb-up-foot">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!uploaded.length || going.length > 0 || busyKb || saving}
          onClick={() => {
            void save();
          }}
        >
          {saving
            ? t('knowledge.upload.saving')
            : uploaded.length
              ? t('knowledge.upload.saveCount', { count: uploaded.length })
              : t('knowledge.upload.save')}
        </button>
        <span className="mk-meta">
          {busyKb
            ? t('knowledge.upload.waitIndexing')
            : going.length
              ? t('knowledge.upload.waitUploads')
              : t('knowledge.upload.help')}
        </span>
      </div>
    </>
  );
}
