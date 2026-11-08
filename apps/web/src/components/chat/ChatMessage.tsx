import type { TFunction } from 'i18next';
import { lazy, memo, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type {
  Citation,
  ConnectionView,
  DisplayMessage,
  KnowledgeSearch,
  TurnProgress,
  Truncation,
  TurnStep,
} from '../../hooks/chatState';
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  EditIcon,
  ErrorCircleIcon,
  InfoIcon,
  LockIcon,
  RefreshIcon,
  StopIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  WarnIcon,
  X2Icon,
} from '../icons';
import {
  announcedFiles,
  CODE_RECIPIENT,
  CODE_TOOL_NAME,
  codeFileCards,
  codeOutputs,
} from '../../hooks/codeBlock';
import { copyText } from '../../lib/clipboard';
import { useConnections } from '../../pages/connections/ConnectionsContext';
import { linkSourcesOf } from '../../pages/connections/model';
import { useStripSources } from '../../pages/connections/useStripSources';
import { ReadMark } from '../../pages/connections/ReadMark';
import type { RemoteLinkSource } from '../../security/remoteLinks';
import { RateWaitButton, RateWaitLine } from '../RateWait';
import { Soon } from '../Soon';
import { AttachmentChips } from './AttachmentChips';
import { formatMessageTime } from './threadGroups';
import { ChatChartFile } from './ChatChart';
import { CanvasCard } from './canvas/CanvasCard';
import { CodeBlock } from './CodeBlock';
import { ChatTableFile } from './DataTable';
import { FileCard } from './FileCard';
import { KnowledgeCitations, KnowledgeSteps } from './KnowledgeCitations';
import { ToolGroup } from './ToolGroup';

// The markdown stack is the largest chunk and is only needed once there is an agent answer;
// loading it lazily keeps it out of the login page. ChatPage preloads it on mount.
const ChatMarkdown = lazy(() =>
  import('../ChatMarkdown').then((module) => ({ default: module.ChatMarkdown })),
);

/** Copies the message as plain text; shows a check for a moment when it worked. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon"
      title={copied ? t('chat.actions.copied') : t('chat.actions.copy')}
      aria-label={copied ? t('chat.actions.copied') : label}
      onClick={() => {
        // Clipboard access can be denied or missing (permissions, insecure context): fail silently.
        copyText(text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => {
              setCopied(false);
            }, 1500);
          },
          () => undefined,
        );
      }}
    >
      {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
    </button>
  );
}

/**
 * Dots of the phase indicator (design: chat.jsx `ch-orb`). Static decoration: the figure and its
 * rhythm per phase live in the stylesheet (the CSP allows no runtime style tags).
 */
const ORB_DOTS = (
  <>
    <i>
      <b />
    </i>
    <i>
      <b />
    </i>
    <i>
      <b />
    </i>
  </>
);

/** Phase line of a turn in flight (design: chat.jsx `PHASE_TXT`). */
function useProgressLabel(progress: TurnProgress | undefined, running: number): string {
  const { t } = useTranslation();
  if (!progress) return t('chat.progress.thinking');
  if (progress.phase !== 'tool') return t(`chat.progress.${progress.phase}`);
  if (running > 1) return t('chat.progress.toolCount', { count: running });
  // The tool name is shown as text (escaped by React), like in the tool list.
  return progress.tool
    ? t('chat.progress.tool', { tool: progress.tool })
    : t('chat.progress.toolUnnamed');
}

function stepText(t: TFunction, step: TurnStep): string {
  if (step.kind === 'code') {
    // Design round 40: «Ejecutando código» / «Ejecutó código» / «Falló el código».
    if (step.status === 'failed') return t('chat.steps.codeFailed');
    return step.status === 'running' ? t('chat.steps.codeRunning') : t('chat.steps.codeOk');
  }
  if (step.kind !== 'tool') return t(`chat.steps.${step.kind}`);
  const tool = step.tool ?? t('chat.steps.toolUnnamed');
  if (step.status === 'failed') return t('chat.steps.toolFailed', { tool });
  return step.status === 'running'
    ? t('chat.steps.toolRunning', { tool })
    : t('chat.steps.toolOk', { tool });
}

/**
 * Steps of the turn while it runs (design: chat.jsx `ch-steps`): «N pasos · M con error», folded
 * until opened. Observe mode starts it open, like the tool list it replaces while streaming.
 */
function TurnSteps({ steps, observe }: { steps: TurnStep[]; observe: boolean }) {
  const { t } = useTranslation();
  // null = not toggled yet: follow observe mode until the user decides.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? observe;
  const failed = steps.reduce((count, step) => count + (step.status === 'failed' ? 1 : 0), 0);
  return (
    <div className="ch-steps">
      <button
        type="button"
        className="ch-steps-t"
        aria-expanded={open}
        onClick={() => {
          setToggled(!open);
        }}
      >
        <ChevronRightIcon size={11} className={open ? 'tool-chevron is-open' : 'tool-chevron'} />
        {t('chat.steps.count', { count: steps.length })}
        {failed > 0 ? t('chat.steps.failed', { count: failed }) : null}
      </button>
      {open ? (
        <ol className="ch-steps-l">
          {steps.map((step) => (
            <li key={step.id} className={`is-${step.status}`}>
              {step.status === 'running' ? (
                <span className="spinner" aria-hidden="true" />
              ) : step.status === 'failed' ? (
                <X2Icon size={12} />
              ) : (
                <CheckIcon size={12} />
              )}
              <span className="sr-only">{t(`chat.steps.status.${step.status}`)}</span>
              <span>{stepText(t, step)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

const NO_SEARCHES: KnowledgeSearch[] = [];
const NO_CITATIONS: Citation[] = [];
const NO_STEPS: TurnStep[] = [];
const NO_FILES: never[] = [];
const NO_OUTPUTS: ReturnType<typeof codeOutputs> = { charts: [], tables: [] };

interface Props {
  message: DisplayMessage;
  /** Observe mode ("Observar"): live tool calls start expanded and show the LIVE marker. */
  observe: boolean;
  /** Admins get a link to Presupuestos in the budget notice (UI only; the API authorizes). */
  isAdmin: boolean;
  /** Stable callback that sends a message as a new turn (keeps the memoization effective). */
  onSend: (text: string) => void;
  /** Question to send again from a finished agent answer ("Reintentar"); null while streaming. */
  resendText: string | null;
  /** Question to send again when this failed turn can be retried; null otherwise. */
  retryText: string | null;
  /** «Volver a conectar» of a turn whose reading gave up (design round 40). */
  onReconnect?: () => void;
}

const NO_SOURCES: readonly string[] = [];
/** The `recipient` prefix of a Canvas call (`textdoc.create`…, D124). */
const TEXTDOC_RECIPIENT = 'textdoc.';
const NO_LINK_SOURCES: readonly RemoteLinkSource[] = [];

/** The remote services a stored answer read, from the person's connections (read on demand). */
function useRemoteSources(registrations: readonly string[]): readonly RemoteLinkSource[] {
  const { list, ensure } = useConnections();
  const used = registrations.length > 0;
  useEffect(() => {
    if (used) ensure();
  }, [used, ensure]);
  return useMemo(
    () => (used ? linkSourcesOf(registrations, list) : NO_LINK_SOURCES),
    [used, registrations, list],
  );
}

/**
 * Design round 40 `ConnLine` (D120 (4)): the stream of the turn was cut. While it reconnects the
 * text stays and only this line says so; once it is back, «Reconectado» for 2.5 s; after 12
 * attempts, «Volver a conectar», which reads the turn again without asking it again.
 */
function ConnLine({
  connection,
  onReconnect,
}: {
  connection: ConnectionView;
  onReconnect: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  if (connection.kind === 'reconnecting') {
    return (
      <div className="cr-conn" role="status">
        <span className="spinner" aria-hidden="true" />
        {t('chat.connection.reconnecting')}{' '}
        <span className="mono">{t('chat.connection.attempt', { n: connection.attempt })}</span>
      </div>
    );
  }
  if (connection.kind === 'resumed') {
    return (
      <div className="cr-conn is-ok" role="status">
        <CheckIcon size={12} />
        {t('chat.connection.resumed')}
      </div>
    );
  }
  return (
    <div className="mc-alert amber msg-guardrail" role="alert">
      <WarnIcon size={14} />
      <div className="min-w-0 flex-1">
        <b>{t('chat.connection.failedTitle')}</b> {t('chat.connection.failedBody')}
      </div>
      {onReconnect ? (
        <button type="button" className="btn btn-sm" onClick={onReconnect}>
          <RefreshIcon size={11} />
          {t('chat.connection.reconnect')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Design chat.jsx (round 34) «Respuesta incompleta»: the answer reached its token cap. No
 * «Continuar»: the person asks for the rest in a new message. The tool name, when there is
 * one, is plain text from the API's progress (escaped by React).
 */
function TruncatedNotice({ truncation }: { truncation: Truncation }) {
  const { t } = useTranslation();
  return (
    <div className="mc-alert msg-guardrail" role="status">
      <InfoIcon size={14} />
      <div>
        <b>{t('chat.truncated.title')}</b>{' '}
        {truncation.kind === 'tool' ? (
          truncation.tool ? (
            <>
              {t('chat.truncated.toolBefore')}
              <span className="mono">{truncation.tool}</span>
              {t('chat.truncated.toolAfter')}
            </>
          ) : (
            t('chat.truncated.toolUnnamed')
          )
        ) : (
          t('chat.truncated.tokens')
        )}{' '}
        {t('chat.truncated.rest')}
      </div>
    </div>
  );
}

// Memoized: while a turn streams, only the message that changes re-renders.
export const ChatMessage = memo(function ChatMessage({
  message,
  observe,
  isAdmin,
  onSend,
  resendText,
  retryText,
  onReconnect,
}: Props) {
  const { t } = useTranslation();
  const running = message.tools.reduce(
    (count, tool) => count + (tool.status === 'started' ? 1 : 0),
    0,
  );
  const progressLabel = useProgressLabel(message.progress, running);
  const remote = useRemoteSources(message.remoteSources ?? NO_SOURCES);
  const strip = useStripSources(
    message.connectionRequired ?? NO_SOURCES,
    message.remoteSources ?? NO_SOURCES,
  );
  const code = message.code;
  // The cells are the «Analizando» block, not entries of the tool list (design round 40).
  const tools = useMemo(
    () =>
      message.tools.filter(
        (tool) =>
          tool.name !== CODE_RECIPIENT &&
          !(code && tool.name === CODE_TOOL_NAME) &&
          // A Canvas call is its card, not an entry of the tool list (design round 41).
          !tool.name.startsWith(TEXTDOC_RECIPIENT),
      ),
    [message.tools, code],
  );
  const files = useMemo(() => (code ? announcedFiles(code) : NO_FILES), [code]);
  const cards = useMemo(() => (code ? codeFileCards(code) : NO_FILES), [code]);
  const outputs = useMemo(() => (code ? codeOutputs(code) : NO_OUTPUTS), [code]);

  if (message.role === 'user') {
    const time = formatMessageTime(message.createdAt);
    return (
      <article className="msg-user msg-hover">
        <h2 className="sr-only">{t('chat.you')}</h2>
        <div className="msg-user-inner">
          {message.fromOtherTab && (
            <span className="msg-user-origin">{t('chat.fromOtherTab')}</span>
          )}
          {message.attachments && message.attachments.length > 0 && (
            <AttachmentChips files={message.attachments} />
          )}
          {/* User text is shown verbatim (escaped by React), never interpreted as markdown. */}
          <p className="msg-user-bubble">{message.content}</p>
          <div className="msg-actions">
            {time && (
              <time className="msg-time" dateTime={message.createdAt}>
                {time}
              </time>
            )}
            <Soon name={t('soon.item', { label: t('chat.actions.edit') })}>
              <span className="btn btn-ghost btn-icon">
                <EditIcon size={11} />
              </span>
            </Soon>
            <CopyButton text={message.content} label={t('chat.actions.copyMessage')} />
          </div>
        </div>
      </article>
    );
  }

  const streaming = message.status === 'streaming';
  const connection = message.connection;
  // Design round 40: while the connection is cut, the cursor and the phase line are hidden.
  const cut = connection !== undefined && connection.kind !== 'resumed';
  const writing = streaming && message.progress?.phase === 'writing';
  const steps = message.steps ?? NO_STEPS;
  const budgetExceeded = message.errorKey === 'errors.budget_exceeded';
  const finished =
    (message.status === 'done' ||
      message.status === 'stopped' ||
      message.status === 'interrupted' ||
      message.status === 'away') &&
    message.content;
  // Design round 40: a stopped, interrupted or still running answer is not asked again from it.
  const resendable = message.status === 'done' && !message.truncated;
  // A cancelled answer keeps its partial text as is, followed by a separate note (design: chat.jsx
  // "stopped_note"); with nothing received yet, only the note is shown.
  const stoppedNote = message.status === 'stopped' && (
    <p className="msg-stopped">
      <StopIcon size={11} />
      {t('chat.stopped')}
    </p>
  );
  if (stoppedNote && !message.content && message.tools.length === 0) return stoppedNote;

  return (
    <>
      <article className="msg-agent msg-hover" aria-busy={streaming}>
        <h2 className="sr-only">{t('chat.assistant')}</h2>
        {/* Design: while the turn runs its steps are listed; the tool group comes once it ends. */}
        {streaming ? (
          steps.length > 1 ? (
            <TurnSteps steps={steps} observe={observe} />
          ) : null
        ) : (
          <ToolGroup tools={tools} live={false} />
        )}
        <KnowledgeSteps searches={message.searches ?? NO_SEARCHES} />
        {/* Design round 40: the block of the cells goes before the text of the answer. */}
        {code ? <CodeBlock block={code} streaming={streaming} /> : null}
        {/* Design remote-core.jsx: the answer read a remote service (content from outside). */}
        {remote.map((source) => (
          <ReadMark key={source.service} service={source.service} />
        ))}
        {message.content ? (
          // Until the markdown chunk loads, the text is shown as plain text (escaped by React).
          <Suspense fallback={<p className="md whitespace-pre-wrap">{message.content}</p>}>
            <ChatMarkdown streaming={writing && !cut} remote={remote} strip={strip} files={files}>
              {message.content}
            </ChatMarkdown>
          </Suspense>
        ) : null}
        {/* The phase stays under the partial text while the agent calls tools or the next block
            is on its way; while it writes, the cursor says so. */}
        {streaming && connection ? (
          <ConnLine connection={connection} onReconnect={onReconnect} />
        ) : null}
        {streaming && !cut && !(writing && message.content) ? (
          <p className="msg-thinking ch-phase" role="status" aria-live="polite">
            <span
              className="ch-orb"
              data-k={message.progress?.phase ?? 'thinking'}
              aria-hidden="true"
            >
              {ORB_DOTS}
            </span>
            <span className="ch-phase-t">{progressLabel}</span>
            {observe ? (
              <span className="ch-live mono">
                <span className="dot dot-blue" aria-hidden="true" />
                {t('chat.live')}
              </span>
            ) : null}
          </p>
        ) : null}
        {writing && !cut && message.content ? (
          <span className="sr-only" role="status">
            {t('chat.progress.writing')}
          </span>
        ) : null}
        {message.guardrail ? (
          <div className="mc-alert amber msg-guardrail" role="status">
            <LockIcon size={14} />
            <div>{t('chat.guardrail')}</div>
          </div>
        ) : null}
        {message.truncated ? <TruncatedNotice truncation={message.truncated} /> : null}
        {message.status === 'interrupted' ? (
          <div className="mc-alert amber msg-guardrail" role="status">
            <WarnIcon size={14} />
            <div>
              <b>{t('chat.interrupted.title')}</b> {t('chat.interrupted.body')}
            </div>
          </div>
        ) : null}
        {message.status === 'away' ? (
          <p className="msg-away">
            <span className="spinner" aria-hidden="true" />
            {t('chat.away')}
          </p>
        ) : null}
        <KnowledgeCitations citations={message.citations ?? NO_CITATIONS} />
        {/* Design round 40: after the text, its charts, its tables and then its files
            (bloque → texto → gráfica → tabla → archivos). */}
        {outputs.charts.map((file) => (
          <ChatChartFile key={file.file_id} file={file} />
        ))}
        {outputs.tables.map((table) => (
          <ChatTableFile key={table.file.file_id} file={table.file} csv={table.csv} />
        ))}
        {cards.map((file) => (
          <FileCard key={file.file_id} file={file} />
        ))}
        {message.textdocs?.map((card) => (
          <CanvasCard key={card.textdoc_id} card={card} />
        ))}
        {message.files?.map((file) => (
          <FileCard key={file.file_id} file={file} />
        ))}
        {message.status === 'error' &&
          (budgetExceeded ? (
            <div role="alert" className="notice notice-amber msg-notice">
              <WarnIcon size={14} />
              <div className="min-w-0 flex-1">
                <p className="notice-title">{t('chat.systemNotice')}</p>
                <p>{t('errors.budget_exceeded')}</p>
              </div>
              {isAdmin && (
                <Link to="/budgets" className="btn btn-sm btn-ghost">
                  {t('chat.viewBudget')}
                </Link>
              )}
            </div>
          ) : (
            <div role="alert" className="notice notice-red msg-notice items-center">
              <ErrorCircleIcon size={14} />
              {message.retryAt !== undefined ? (
                // Design chat.jsx round 34: a 429 says how long to wait, from its `Retry-After`.
                <p className="min-w-0 flex-1">
                  <b className="msg-notice-title">{t('errors.rateLimitedTitle')}</b>
                  {t('errors.rate_limited')} <RateWaitLine until={message.retryAt} />
                </p>
              ) : (
                <p className="min-w-0 flex-1">{t(message.errorKey ?? 'errors.generic')}</p>
              )}
              {retryText !== null && message.retryAt !== undefined && (
                <RateWaitButton
                  until={message.retryAt}
                  onRetry={() => {
                    onSend(retryText);
                  }}
                />
              )}
              {retryText !== null && message.retryAt === undefined && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    onSend(retryText);
                  }}
                >
                  <RefreshIcon size={11} />
                  {t('chat.retry')}
                </button>
              )}
            </div>
          ))}
        {finished && (
          <div className="msg-actions msg-actions-agent">
            <CopyButton text={message.content} label={t('chat.actions.copyAnswer')} />
            <Soon name={t('soon.item', { label: t('chat.actions.feedback') })}>
              <span className="inline-flex gap-0.5">
                <span className="btn btn-ghost btn-icon">
                  <ThumbsUpIcon size={11} />
                </span>
                <span className="btn btn-ghost btn-icon">
                  <ThumbsDownIcon size={11} />
                </span>
              </span>
            </Soon>
            {/* Design round 34: asking again would be cut the same way and charged again. */}
            {resendText !== null && resendable && (
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                title={t('chat.actions.resend')}
                aria-label={t('chat.actions.resend')}
                onClick={() => {
                  onSend(resendText);
                }}
              >
                <RefreshIcon size={11} />
              </button>
            )}
          </div>
        )}
      </article>
      {stoppedNote}
    </>
  );
});
