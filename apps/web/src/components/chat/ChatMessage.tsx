import type { TFunction } from 'i18next';
import { lazy, memo, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { DisplayMessage, TurnProgress, TurnStep } from '../../hooks/chatState';
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  EditIcon,
  ErrorCircleIcon,
  LockIcon,
  RefreshIcon,
  StopIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  WarnIcon,
  X2Icon,
} from '../icons';
import { copyText } from '../../lib/clipboard';
import { Soon } from '../Soon';
import { formatMessageTime } from './threadGroups';
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

const NO_STEPS: TurnStep[] = [];

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
}

// Memoized: while a turn streams, only the message that changes re-renders.
export const ChatMessage = memo(function ChatMessage({
  message,
  observe,
  isAdmin,
  onSend,
  resendText,
  retryText,
}: Props) {
  const { t } = useTranslation();
  const running = message.tools.reduce(
    (count, tool) => count + (tool.status === 'started' ? 1 : 0),
    0,
  );
  const progressLabel = useProgressLabel(message.progress, running);

  if (message.role === 'user') {
    const time = formatMessageTime(message.createdAt);
    return (
      <article className="msg-user msg-hover">
        <h2 className="sr-only">{t('chat.you')}</h2>
        <div className="msg-user-inner">
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
  const writing = streaming && message.progress?.phase === 'writing';
  const steps = message.steps ?? NO_STEPS;
  const budgetExceeded = message.errorKey === 'errors.budget_exceeded';
  const finished = (message.status === 'done' || message.status === 'stopped') && message.content;
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
          <ToolGroup tools={message.tools} live={false} />
        )}
        {message.content ? (
          // Until the markdown chunk loads, the text is shown as plain text (escaped by React).
          <Suspense fallback={<p className="md whitespace-pre-wrap">{message.content}</p>}>
            <ChatMarkdown streaming={writing}>{message.content}</ChatMarkdown>
          </Suspense>
        ) : null}
        {/* The phase stays under the partial text while the agent calls tools or the next block
            is on its way; while it writes, the cursor says so. */}
        {streaming && !(writing && message.content) ? (
          <p className="msg-thinking ch-phase" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>{progressLabel}</span>
            {observe ? (
              <span className="msg-live mono">
                <span className="dot dot-blue" aria-hidden="true" />
                {t('chat.live')}
              </span>
            ) : null}
          </p>
        ) : null}
        {writing && message.content ? (
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
              <p className="min-w-0 flex-1">{t(message.errorKey ?? 'errors.generic')}</p>
              {retryText !== null && (
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
            {resendText !== null && (
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
