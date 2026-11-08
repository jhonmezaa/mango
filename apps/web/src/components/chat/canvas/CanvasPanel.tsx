import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../../api/errors';
import { useSession } from '../../../auth/useSession';
import { ChatMarkdown } from '../../ChatMarkdown';
import {
  ChatIcon,
  CheckIcon,
  CloseIcon,
  CommentIcon,
  DiffIcon,
  DocumentIcon,
  DownloadIcon,
  EditIcon,
  HistoryIcon,
  TerminalIcon,
} from '../../icons';
import {
  downloadText,
  fileName,
  isCode,
  LANGUAGE,
  useTextdoc,
  useVersionTexts,
  type Textdoc,
  type TextdocCard,
  type TextdocExport,
  type TextdocVersion,
} from './canvasApi';
import { CanvasPreview } from './CanvasPreview';
import { lineDiff } from './lineDiff';

/**
 * Design round 41 `CanvasPanel` (D124): a document or a piece of code of the conversation next
 * to the chat, with its versions, «Mostrar cambios», the agent's comments, «Editar» → «Guardar
 * versión», «Restaurar esta versión», «Exportar» and, for code, the preview in the second origin.
 *
 * Every text here came from the model or from the person (untrusted): a document is Markdown
 * without raw HTML (`ChatMarkdown`), code and the diff are text React escapes. Nothing of it runs
 * in the SPA's origin. The API decides what may be read or written (the person's own
 * conversation); this panel only shows it.
 */

interface Props {
  conversationId: string;
  card: TextdocCard;
  agentName: string;
  onClose: () => void;
  /** «Responder en el chat»: the text left in the composer. */
  onAsk: (text: string) => void;
  /** A Word or PDF export: its card, as a message of the conversation (design round 40). */
  onExported: (file: { file_id: string; name: string; kind: string; size_bytes: number }) => void;
  notify: (message: string, tone: 'success' | 'info' | 'error') => void;
}

const NO_MARKS: readonly string[] = [];

function timeOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const EXTENSION_LABEL: Partial<Record<TextdocExport, string>> = {
  md: '.md',
  py: '.py',
  jsx: '.jsx',
  html: '.html',
};

export const CanvasPanel = memo(function CanvasPanel(props: Props) {
  const [round, setRound] = useState(0);
  const loaded = useTextdoc(
    props.conversationId,
    props.card.textdoc_id,
    round + props.card.version,
  );
  const { t } = useTranslation();
  const Icon = isCode(props.card.kind) ? TerminalIcon : DocumentIcon;
  if (loaded.kind !== 'ready') {
    return (
      <aside className="cv" aria-label={t('chat.canvas.aria', { title: props.card.title })}>
        <div className="cv-h">
          <span className="cv-h-ic">
            <Icon size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="cv-h-t">{props.card.title}</div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t('chat.canvas.close')}
            onClick={props.onClose}
          >
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="cv-body">
          {loaded.kind === 'loading' ? (
            <div className="cv-fr-msg" role="status">
              <span className="spinner" aria-hidden="true" /> {t('chat.canvas.loading')}
            </div>
          ) : (
            <div className="notice notice-red" role="alert">
              <span className="min-w-0 flex-1">{t('chat.canvas.loadError')}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setRound((n) => n + 1);
                }}
              >
                {t('chat.canvas.retry')}
              </button>
            </div>
          )}
        </div>
      </aside>
    );
  }
  return (
    // Keyed by its latest version: a new one (the agent's or the person's) opens on it.
    <CanvasDoc
      key={loaded.value.latest}
      {...props}
      doc={loaded.value}
      reload={() => {
        setRound((n) => n + 1);
      }}
    />
  );
});

function CanvasDoc({
  conversationId,
  doc,
  agentName,
  onClose,
  onAsk,
  onExported,
  notify,
  reload,
}: Props & { doc: Textdoc; reload: () => void }) {
  const { t } = useTranslation();
  const { api } = useSession();
  const code = isCode(doc.kind);
  const versions = doc.versions;
  const last = versions.length - 1;
  const [cur, setCur] = useState(last);
  const [diff, setDiff] = useState(false);
  const [hist, setHist] = useState(false);
  const [exp, setExp] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const [tab, setTab] = useState<'code' | 'preview'>(code ? 'preview' : 'code');
  const [saving, setSaving] = useState(false);
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const { texts, want, put, failed } = useVersionTexts(conversationId, doc.textdoc_id);

  const version: TextdocVersion | undefined = versions[cur];
  const number = version?.version ?? 1;
  const text = texts.get(number);
  const previous = cur > 0 ? versions[cur - 1] : undefined;
  const before = previous ? texts.get(previous.version) : undefined;
  useEffect(() => {
    want(number);
    if (diff && previous) want(previous.version);
  }, [want, number, diff, previous]);

  const old = cur !== last;
  // The agent's first version has no note of its own: the design calls it «Primer borrador».
  const noteOf = (v: TextdocVersion, i: number) =>
    v.note || (i === 0 ? t('chat.canvas.firstDraft') : ' ');
  const who = (v: TextdocVersion) => (v.by === 'person' ? t('chat.canvas.you') : agentName);
  const comments = useMemo(
    () => doc.comments.filter((c) => !resolved.has(c.comment_id)),
    [doc.comments, resolved],
  );
  const marks = useMemo(() => comments.map((c) => c.quote), [comments]);
  const lines = useMemo(
    () => (diff && before !== undefined && text !== undefined ? lineDiff(before, text) : null),
    [diff, before, text],
  );

  const save = useCallback(
    async (content: string, restoredFrom?: number) => {
      const base = versions[last]?.version ?? 1;
      setSaving(true);
      try {
        const out = await api.call('saveTextdocVersion', {
          path: { conversation_id: conversationId, textdoc_id: doc.textdoc_id },
          body: { content, base, ...(restoredFrom ? { restored_from: restoredFrom } : {}) },
        });
        put(out.version, content);
        setEdit(null);
        notify(
          restoredFrom
            ? t('chat.canvas.restored', { from: restoredFrom, n: out.version })
            : t('chat.canvas.saved', { n: out.version }),
          'success',
        );
        reload();
      } catch (error) {
        notify(
          error instanceof ApiError && error.status === 409
            ? t('chat.canvas.conflict')
            : t('chat.canvas.saveError'),
          'error',
        );
      } finally {
        setSaving(false);
      }
    },
    [api, conversationId, doc.textdoc_id, versions, last, put, notify, reload, t],
  );

  const doExport = async (format: TextdocExport) => {
    setExp(false);
    if (format !== 'docx' && format !== 'pdf') {
      if (text === undefined) return;
      const name = fileName(doc.title, format);
      downloadText(text, name);
      notify(t('chat.canvas.downloading', { name }), 'success');
      return;
    }
    notify(t('chat.canvas.generating', { kind: format.toUpperCase() }), 'info');
    try {
      const out = await api.call('exportTextdoc', {
        path: { conversation_id: conversationId, textdoc_id: doc.textdoc_id },
        body: { format, version: number },
      });
      onExported(out.file);
    } catch {
      notify(t('chat.canvas.exportError'), 'error');
    }
  };

  const resolve = (commentId: string) => {
    setResolved((current) => new Set(current).add(commentId));
    void api.resolveTextdocComment(conversationId, doc.textdoc_id, commentId).catch(() => {
      setResolved((current) => {
        const next = new Set(current);
        next.delete(commentId);
        return next;
      });
    });
  };

  const Icon = code ? TerminalIcon : DocumentIcon;
  const kindLabel = code
    ? t('chat.canvas.kindCode', { language: LANGUAGE[doc.kind] })
    : t('chat.canvas.kindDocument');
  const showsText = !code || tab === 'code';
  return (
    <aside className="cv" aria-label={t('chat.canvas.aria', { title: doc.title })}>
      <div className="cv-h">
        <span className="cv-h-ic">
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="cv-h-t">{doc.title}</div>
          <div className="cv-h-s">
            {t('chat.canvas.subtitle', {
              kind: kindLabel,
              n: cur + 1,
              m: versions.length,
              who:
                version?.by === 'person'
                  ? t('chat.canvas.byYou')
                  : t('chat.canvas.byAgent', { agent: agentName }),
            })}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={t('chat.canvas.history')}
          title={t('chat.canvas.historyTitle')}
          aria-pressed={hist}
          onClick={() => {
            setHist((h) => !h);
          }}
        >
          <HistoryIcon size={13} />
        </button>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={exp}
            onClick={() => {
              setExp((x) => !x);
            }}
          >
            <DownloadIcon size={11} /> {t('chat.canvas.export')}
          </button>
          {exp && (
            <div className="popover cv-menu" role="menu">
              {doc.exports.map((format) => (
                <button
                  key={format}
                  type="button"
                  role="menuitem"
                  disabled={(format === 'md' || code) && text === undefined}
                  onClick={() => {
                    void doExport(format);
                  }}
                >
                  <span>
                    {EXTENSION_LABEL[format] ??
                      (format === 'docx'
                        ? t('chat.canvas.exportWord')
                        : t('chat.canvas.exportPdf'))}
                  </span>
                  <span className="mk-meta">
                    {format === 'docx' || format === 'pdf'
                      ? t('chat.canvas.exportChat')
                      : t('chat.canvas.exportNow')}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={t('chat.canvas.close')}
          onClick={onClose}
        >
          <CloseIcon size={13} />
        </button>
      </div>
      <div className="cv-bar">
        {code && (
          <div className="tk-quick" role="tablist">
            {(['code', 'preview'] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={tab === key ? 'is-on' : ''}
                onClick={() => {
                  setTab(key);
                }}
              >
                {key === 'code' ? t('chat.canvas.tabCode') : t('chat.canvas.tabPreview')}
              </button>
            ))}
          </div>
        )}
        {showsText && (
          <button
            type="button"
            className={`btn btn-sm ${diff ? 'btn-primary' : 'btn-ghost'}`}
            aria-pressed={diff}
            disabled={cur === 0 || edit !== null}
            title={
              cur === 0 ? t('chat.canvas.firstVersion') : t('chat.canvas.compareWith', { n: cur })
            }
            onClick={() => {
              setDiff((x) => !x);
            }}
          >
            <DiffIcon size={11} /> {t('chat.canvas.showChanges')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        {showsText &&
          !old &&
          (edit === null ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={text === undefined}
              onClick={() => {
                if (text === undefined) return;
                setEdit(text);
                setDiff(false);
              }}
            >
              <EditIcon size={11} /> {t('chat.canvas.edit')}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setEdit(null);
                }}
              >
                {t('chat.canvas.discard')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={edit === text || saving}
                onClick={() => {
                  void save(edit);
                }}
              >
                {t('chat.canvas.saveVersion')}
              </button>
            </>
          ))}
      </div>
      {old && version && (
        <div className="cv-old" role="status">
          <HistoryIcon size={13} />
          <span style={{ flex: 1 }}>
            {t('chat.canvas.oldNotice', {
              n: cur + 1,
              at: timeOf(version.created_at),
              who:
                version.by === 'person'
                  ? t('chat.canvas.oldYours')
                  : t('chat.canvas.byAgent', { agent: agentName }),
            })}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setCur(last);
            }}
          >
            {t('chat.canvas.goLatest')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={text === undefined || saving}
            onClick={() => {
              if (text !== undefined) void save(text, number);
            }}
          >
            {t('chat.canvas.restore')}
          </button>
        </div>
      )}
      <div className="cv-main">
        <div className="cv-body">
          {code && tab === 'preview' ? (
            text === undefined ? (
              <Loading failed={failed} />
            ) : (
              <CanvasPreview kind={doc.kind as Exclude<typeof doc.kind, 'document'>} code={text} />
            )
          ) : edit !== null ? (
            <textarea
              className="cv-edit mono"
              value={edit}
              onChange={(event) => {
                setEdit(event.target.value);
              }}
              aria-label={t('chat.canvas.editLabel')}
              spellCheck={!code}
            />
          ) : lines !== null && version ? (
            <>
              <div className="cv-diff-h">
                {t('chat.canvas.changesTitle', {
                  from: cur,
                  to: cur + 1,
                  note: noteOf(version, cur),
                })}
              </div>
              <pre className="rv-diff cv-diff">
                {lines.map(([kind, line], n) => (
                  <div key={n} className={kind === '+' ? 'add' : kind === '-' ? 'rem' : ''}>
                    <span>{kind}</span>
                    {line || ' '}
                  </div>
                ))}
              </pre>
            </>
          ) : text === undefined ? (
            <Loading failed={failed} />
          ) : code ? (
            <pre className="cv-code mono">{text}</pre>
          ) : (
            <div className="cv-doc">
              <ChatMarkdown marks={old ? NO_MARKS : marks}>{text}</ChatMarkdown>
            </div>
          )}
          {!old && edit === null && !diff && showsText && comments.length > 0 && (
            <div className="cv-cmts">
              <div className="cv-cmts-t">
                <CommentIcon size={12} />{' '}
                {t('chat.canvas.comments', { count: comments.length, agent: agentName })}
              </div>
              {comments.map((c) => (
                <div key={c.comment_id} className="cv-cmt">
                  <div className="cv-cmt-q mono">{c.quote}</div>
                  <div className="cv-cmt-x">{c.text}</div>
                  <div className="row gap-2">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        resolve(c.comment_id);
                      }}
                    >
                      <CheckIcon size={11} /> {t('chat.canvas.resolve')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        onAsk(
                          t('chat.canvas.answerPrefix', {
                            quote: c.quote.split(' | ')[0] ?? c.quote,
                          }),
                        );
                      }}
                    >
                      <ChatIcon size={11} /> {t('chat.canvas.answerInChat')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {hist && (
          <div className="cv-hist" aria-label={t('chat.canvas.versions')}>
            <div className="cv-hist-t">{t('chat.canvas.versions')}</div>
            {versions
              .map((v, i) => ({ v, i }))
              .reverse()
              .map(({ v, i }) => (
                <button
                  key={v.version}
                  type="button"
                  className={`cv-hist-i${i === cur ? ' is-on' : ''}`}
                  aria-current={i === cur}
                  onClick={() => {
                    setCur(i);
                    setDiff(false);
                    setEdit(null);
                    if (code) setTab('code');
                  }}
                >
                  <span className="mono">v{i + 1}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="cv-hist-n">{noteOf(v, i)}</span>
                    <span className="mk-meta">
                      {timeOf(v.created_at)} · {who(v)}
                    </span>
                  </span>
                  {i === last && <span className="badge">{t('chat.canvas.current')}</span>}
                </button>
              ))}
            <div className="mk-meta" style={{ padding: '10px 12px' }}>
              {t('chat.canvas.versionsFooter')}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function Loading({ failed }: { failed: boolean }) {
  const { t } = useTranslation();
  return failed ? (
    <div className="notice notice-red" role="alert">
      {t('chat.canvas.loadError')}
    </div>
  ) : (
    <div className="cv-fr-msg" role="status">
      <span className="spinner" aria-hidden="true" /> {t('chat.canvas.loading')}
    </div>
  );
}
