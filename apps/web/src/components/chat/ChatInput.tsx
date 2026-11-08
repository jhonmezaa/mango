import { useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { MESSAGE_MAX_LENGTH } from '../../api/schemas';
import { PaperclipIcon, SendIcon, StopIcon } from '../icons';
import { Soon } from '../Soon';
import { AttachmentChips } from './AttachmentChips';
import { MAX_ATTACHMENTS, type ComposerAttachment } from './attachments';

/** The composer's files (D116), from `useChatAttachments`. */
export interface ComposerFiles {
  items: readonly ComposerAttachment[];
  /** Files left out by the last pick or drop, past the 20 of a message. */
  overflow: number;
  gate: 'busy' | 'bad' | null;
  add: (files: readonly File[]) => void;
  remove: (id: string) => void;
  retry: (id: string) => void;
}

interface Props {
  /** Name of the agent the message goes to (written by its creator; rendered as text). */
  agentName: string;
  /** No agent to talk to: unknown, retired or not available to this user. */
  disabled?: boolean;
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /**
   * A message that did not go out goes back to the box (design round 40, «otra pestaña»): each
   * new `key` puts its `text` in the box again.
   */
  restore?: { text: string; key: number } | null;
  /**
   * The files of the message. Without them (or with `canAttach` false) «Adjuntar» is disabled
   * with its reason: the agent's version cannot read files (design round 40, D116).
   */
  files?: ComposerFiles | null;
  /** The agent's version has «Ejecutar código» (`capabilities`), so it can read files. */
  canAttach?: boolean;
}

/**
 * Composer (design: chat.jsx ChatInput). "/" commands are "Próximamente", so typing "/" opens no
 * command menu. There is no «Skill» button (design round 23): a skill cannot be forced, the
 * agent loads one when it helps. Attachments (design round 40, D116): up to 20 files, and
 * «Enviar» waits until every one is uploaded and scanned.
 */
export function ChatInput({
  agentName,
  disabled = false,
  isStreaming,
  onSend,
  onStop,
  restore = null,
  files = null,
  canAttach = false,
}: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  // «Adjuntar» of an agent that cannot read files says why once pressed (design `why`).
  const [why, setWhy] = useState<string | null>(null);
  const attachable = canAttach && files !== null;
  const items = files?.items ?? [];
  const gate = files?.gate ?? null;
  // Adjusted while rendering (no effect): the box shows the message that came back at once.
  const [restored, setRestored] = useState<number | null>(null);
  if (restore && restore.key !== restored) {
    setRestored(restore.key);
    setText(restore.text);
  }
  const trimmed = text.trim();
  // Like the design, the limit counts what was typed; there is no visible counter, only the error.
  const tooLong = text.length > MESSAGE_MAX_LENGTH;
  // Design: a message may be only its files; it waits while one uploads or has a problem.
  const canSend =
    !disabled && !isStreaming && (trimmed.length > 0 || items.length > 0) && !tooLong && !gate;

  const submit = (event?: { preventDefault: () => void }) => {
    event?.preventDefault();
    if (!canSend) return;
    onSend(trimmed);
    setText('');
  };
  const whyShown = !attachable && why === agentName;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className="composer">
      <div className="composer-box">
        {files && items.length > 0 && (
          <div className="composer-attachments">
            <AttachmentChips files={items} onRemove={files.remove} onRetry={files.retry} />
          </div>
        )}
        {files && files.overflow > 0 && (
          <p role="alert" className="composer-att-note">
            {t('chat.attachments.overflow', { count: files.overflow, max: MAX_ATTACHMENTS })}
          </p>
        )}
        {attachable && (
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const picked = event.target.files;
              if (picked) files.add(Array.from(picked));
              event.target.value = '';
            }}
          />
        )}
        <textarea
          id="chat-input"
          name="message"
          rows={2}
          value={text}
          maxLength={MESSAGE_MAX_LENGTH + 500}
          aria-label={t('chat.inputLabel', { name: agentName })}
          placeholder={t('chat.placeholder', { name: agentName })}
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={onKeyDown}
          className="composer-textarea"
          aria-invalid={tooLong}
          {...(tooLong ? { 'aria-describedby': 'chat-input-error' } : {})}
        />
        <div className="composer-row ch-compose-bar">
          <div className="flex items-center gap-1">
            {attachable ? (
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                title={t('chat.composer.attach')}
                aria-label={t('chat.composer.attach')}
                disabled={disabled}
                onClick={() => fileRef.current?.click()}
              >
                <PaperclipIcon size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-icon composer-attach-off"
                aria-disabled="true"
                title={t('chat.attachments.cannotTitle', { name: agentName })}
                aria-label={t('chat.attachments.attachOff')}
                {...(whyShown ? { 'aria-describedby': 'chat-input-why' } : {})}
                onClick={() => {
                  setWhy(agentName);
                }}
              >
                <PaperclipIcon size={14} />
              </button>
            )}
          </div>
          <div className="ch-send-row flex items-center gap-2">
            <span className="composer-hint ch-send-hint">
              <Soon name={t('soon.item', { label: t('chat.composer.commandsLabel') })}>
                <span>
                  <span className="mono">/</span> {t('chat.composer.commands')}
                </span>
              </Soon>
              <span aria-hidden="true">·</span>
              <span>
                <span className="mono">⇧↵</span> {t('chat.composer.newLine')}
              </span>
            </span>
            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                className="btn btn-sm ch-send-btn"
                aria-label={t('chat.stopLabel')}
              >
                <StopIcon size={11} />
                <span className="ch-send-lbl">{t('chat.stop')}</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                className="btn btn-sm btn-primary ch-send-btn"
                aria-label={t('chat.send')}
              >
                <span className="ch-send-lbl">{t('chat.send')}</span>
                <SendIcon size={11} />
              </button>
            )}
          </div>
        </div>
        {!disabled && whyShown && (
          <p id="chat-input-why" role="status" className="composer-why">
            {t('chat.attachments.cannot', { name: agentName })}
          </p>
        )}
        {gate && (
          <p role="status" className={gate === 'bad' ? 'composer-gate is-bad' : 'composer-gate'}>
            {t(gate === 'busy' ? 'chat.attachments.waitBusy' : 'chat.attachments.waitBad')}
          </p>
        )}
        {tooLong && (
          <p id="chat-input-error" role="alert" className="composer-error">
            {t('chat.tooLong')}
          </p>
        )}
      </div>
    </form>
  );
}
