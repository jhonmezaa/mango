import { useTranslation } from 'react-i18next';

import { CloseIcon, DocumentIcon, WarnIcon } from '../icons';
import {
  formatFileSize,
  isBadAttachment,
  type AttachmentStatus,
  type ComposerAttachment,
  type MessageAttachment,
} from './attachments';

type ChipStatus = AttachmentStatus | 'gone';

interface Chip {
  id: string;
  name: string;
  size: number;
  status: ChipStatus;
  percent: number;
}

const STATUS_KEYS = {
  blocked: 'chat.attachments.blocked',
  unsupported: 'chat.attachments.unsupported',
  mismatch: 'chat.attachments.mismatch',
  too_large: 'chat.attachments.tooLarge',
  failed: 'chat.attachments.failed',
  gone: 'chat.attachments.gone',
} as const;

interface Props {
  /** The composer's files, or the files of a message on screen. */
  files: readonly ComposerAttachment[] | readonly MessageAttachment[];
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
}

function chipOf(file: ComposerAttachment | MessageAttachment): Chip {
  if ('status' in file) {
    return {
      id: file.id,
      name: file.name,
      size: file.size,
      status: file.status,
      percent: file.percent,
    };
  }
  return {
    id: file.fileId,
    name: file.name,
    size: file.size,
    status: file.gone ? 'gone' : 'ready',
    percent: 100,
  };
}

/**
 * Design chat-run.jsx `CrAttachChips`: one chip per file, with its name and either its size or
 * where it is. File names come from the person (or the history) and render as text.
 */
export function AttachmentChips({ files, onRemove, onRetry }: Props) {
  const { t, i18n } = useTranslation();
  const chips = (files as readonly (ComposerAttachment | MessageAttachment)[]).map(chipOf);
  return (
    <div className="cr-att">
      {chips.map((chip) => {
        const { status } = chip;
        const bad = status !== 'gone' && status !== 'ready' && isBadAttachment(status);
        const meta =
          status === 'uploading'
            ? t('chat.attachments.uploading', { percent: chip.percent })
            : status === 'scanning'
              ? t('chat.attachments.scanning')
              : status === 'ready'
                ? formatFileSize(chip.size, i18n.language)
                : t(STATUS_KEYS[status]);
        return (
          <span
            key={chip.id}
            className={`cr-chip is-${status}${bad ? ' is-bad' : ''}`}
            {...(status === 'gone' ? { title: t('chat.attachments.goneTitle') } : {})}
          >
            {status === 'uploading' || status === 'scanning' ? (
              <span className="spinner" aria-hidden="true" />
            ) : bad ? (
              <WarnIcon size={12} />
            ) : (
              <DocumentIcon size={12} />
            )}
            <span className="cr-chip-n">{chip.name}</span>
            <span className="cr-chip-m">{meta}</span>
            {status === 'failed' && onRetry && (
              <button
                type="button"
                className="sr-link"
                onClick={() => {
                  onRetry(chip.id);
                }}
              >
                {t('chat.attachments.retry')}
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                className="cr-chip-x"
                aria-label={t('chat.attachments.remove', { name: chip.name })}
                onClick={() => {
                  onRemove(chip.id);
                }}
              >
                <CloseIcon size={11} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
