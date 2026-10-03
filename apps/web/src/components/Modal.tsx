import { useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useFocusTrap } from '../hooks/useFocusTrap';
import { CloseIcon } from './icons';

interface Props {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Blocks closing (Escape, backdrop, close button) while a request is in flight. */
  busy?: boolean;
  wide?: boolean;
}

/**
 * Accessible modal dialog (design: system.jsx Modal): portaled to <body>, focus trapped, Escape
 * and backdrop close it, focus returns to the opener. Content is rendered by React (text only).
 */
export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  busy = false,
  wide = false,
}: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const close = () => {
    if (!busy) onClose();
  };
  const ref = useFocusTrap<HTMLDivElement>(true, close);

  return createPortal(
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy}
        className={wide ? 'modal modal-form modal-wide' : 'modal modal-form'}
      >
        <div className="mb-1 flex items-start justify-between gap-3">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon -mt-1 -mr-2"
            aria-label={t('common.close')}
            onClick={close}
            disabled={busy}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        {description && (
          <p id={descriptionId} className="mb-4 text-[13px] leading-relaxed text-muted">
            {description}
          </p>
        )}
        {children}
        {footer && <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
