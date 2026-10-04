import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { MESSAGE_MAX_LENGTH } from '../../api/schemas';
import { PaperclipIcon, SendIcon, SkillIcon, StopIcon } from '../icons';
import { Soon } from '../Soon';

interface Props {
  /** Name of the agent the message goes to (written by its creator; rendered as text). */
  agentName: string;
  /** No agent to talk to: unknown, retired or not available to this user. */
  disabled?: boolean;
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

/**
 * Composer (design: chat.jsx ChatInput) in "current availability" mode: attachments, skills and
 * "/" commands are "Próximamente", so typing "/" opens no command menu.
 */
export function ChatInput({ agentName, disabled = false, isStreaming, onSend, onStop }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const trimmed = text.trim();
  // Like the design, the limit counts what was typed; there is no visible counter, only the error.
  const tooLong = text.length > MESSAGE_MAX_LENGTH;
  const canSend = !disabled && !isStreaming && trimmed.length > 0 && !tooLong;

  const submit = (event?: { preventDefault: () => void }) => {
    event?.preventDefault();
    if (!canSend) return;
    onSend(trimmed);
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className="composer">
      <div className="composer-box">
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
            <Soon name={t('soon.item', { label: t('chat.composer.attach') })}>
              <span className="btn btn-ghost btn-icon">
                <PaperclipIcon size={14} />
              </span>
            </Soon>
            <Soon name={t('soon.item', { label: t('chat.composer.skill') })}>
              <span className="btn btn-ghost btn-sm">
                <SkillIcon size={12} /> {t('chat.composer.skill')}
              </span>
            </Soon>
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
              <button type="button" onClick={onStop} className="btn btn-sm">
                <StopIcon size={11} />
                {t('chat.stop')}
              </button>
            ) : (
              <button type="submit" disabled={!canSend} className="btn btn-sm btn-primary">
                {t('chat.send')}
                <SendIcon size={11} />
              </button>
            )}
          </div>
        </div>
        {tooLong && (
          <p id="chat-input-error" role="alert" className="composer-error">
            {t('chat.tooLong')}
          </p>
        )}
      </div>
    </form>
  );
}
