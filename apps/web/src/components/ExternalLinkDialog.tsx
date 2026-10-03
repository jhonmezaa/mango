import { useTranslation } from 'react-i18next';

import { useFocusTrap } from '../hooks/useFocusTrap';

interface Props {
  url: URL;
  onClose: () => void;
}

/**
 * Confirmation step before leaving Mango through a link produced by the LLM (design chat.jsx
 * "Abrir enlace externo"). The host and the full URL are shown so the user can spot exfiltration
 * attempts (data in query strings, look-alike hosts: TM-001).
 */
export function ExternalLinkDialog({ url, onClose }: Props) {
  const { t } = useTranslation();
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose);

  const open = () => {
    // noopener/noreferrer: the new page gets no handle to this window and no Referer.
    window.open(url.href, '_blank', 'noopener,noreferrer');
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-link-title"
        aria-describedby="external-link-body"
        className="modal external-link-dialog font-sans"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="external-link-title" className="modal-title">
          {t('markdown.externalLinkTitle')}
        </h2>
        <p id="external-link-body" className="external-link-body">
          {t('markdown.externalLinkBody')}
        </p>
        {/* Design chat.jsx: the host in bold above the full URL, so look-alike domains stand out
            (TM-001). */}
        <p className="external-link-host" data-testid="host">
          {url.host}
        </p>
        <p className="mono external-link-url" data-testid="url">
          {url.href}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-sm" data-autofocus onClick={onClose}>
            {t('markdown.cancel')}
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={open}>
            {t('markdown.externalLinkConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
