import { useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useFocusTrap } from '../hooks/useFocusTrap';
import { CloseIcon } from './icons';

interface Props {
  title: string;
  /** Extra class of the title (e.g. `mono` when it is an identifier). */
  titleClassName?: string | undefined;
  /** Avatar or icon before the title. */
  lead?: ReactNode;
  /** Line under the title: status badges, category… */
  meta?: ReactNode;
  /** Width in px on wide screens (design: 440 by default, 500 or 520 in some panels). */
  width?: number;
  /** Fixed below the scrolling content (design `mc-foot`): the actions of the item. */
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Side panel with the detail of one item (design `mk-scrim` + `mk-drawer`: agent detail, MCP
 * server, model). Portaled to <body>, focus trapped, Escape and the backdrop close it and focus
 * returns to the opener. Content is rendered by React (text only).
 */
export function SidePanel({
  title,
  titleClassName,
  lead,
  meta,
  width,
  footer,
  onClose,
  children,
}: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const ref = useFocusTrap<HTMLElement>(true, onClose);

  return createPortal(
    <div
      className="mk-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={ref}
        className="mk-drawer"
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="mk-drawer-h">
          {lead}
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className={`text-[17px] font-semibold text-strong [overflow-wrap:anywhere]${titleClassName ? ` ${titleClassName}` : ''}`}
            >
              {title}
            </h2>
            {meta ? <div className="mt-1 flex flex-wrap items-center gap-2">{meta}</div> : null}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="mk-drawer-b">{children}</div>
        {footer ? <div className="mc-foot">{footer}</div> : null}
      </aside>
    </div>,
    document.body,
  );
}
