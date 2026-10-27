import { useTranslation } from 'react-i18next';

import { WarnIcon } from '../components/icons';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { classifyRemoteLink, type RemoteLinkSource } from './remoteLinks';

interface Props {
  url: URL;
  sources: readonly RemoteLinkSource[];
  onClose: () => void;
}

/**
 * «Abrir enlace externo» for a turn that read a remote service (design remote-core.jsx
 * `RemoteLinkBody`). The content came from outside Mango, so the dialog says where the link really
 * goes: the organization of the company, another organization of the service or another domain.
 * Only an `own` link gets «Abrir enlace» as the main action; for the rest, «Cancelar» is.
 */
export function RemoteLinkDialog({ url, sources, onClose }: Props) {
  const { t } = useTranslation();
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose);
  const link = classifyRemoteLink(url, sources);
  const own = link.kind === 'own';
  const readService = sources.map((source) => source.service).join(', ');

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
        aria-labelledby="remote-link-title"
        className="modal external-link-dialog remote-link-dialog font-sans"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="remote-link-title" className="modal-title">
          {t('markdown.externalLinkTitle')}
        </h2>
        <div className="mc-alert amber mb-3.5">
          <WarnIcon size={14} />
          <div>
            {t('connections.link.warnBefore')}
            <b>{readService}</b>
            {t('connections.link.warnAfter')}
          </div>
        </div>
        <div className="rm-dest">
          <div className="rm-copy-l">{t('connections.link.goesTo')}</div>
          <div className="rm-dest-h mono" data-testid="host">
            {link.label}
          </div>
          {own ? (
            <span className="rm-dest-n">
              {t('connections.link.own', { service: link.service, org: link.org ?? '' })}
            </span>
          ) : link.kind === 'other-org' ? (
            <>
              <span className="badge badge-red">{t('connections.link.otherOrg')}</span>
              <span className="rm-dest-n">
                {link.org ? (
                  <>
                    <span className="mono">{link.org}</span>
                    {t('connections.link.otherOrgNamed', { service: link.service })}
                  </>
                ) : (
                  t('connections.link.otherOrgUnnamed', { service: link.service })
                )}
              </span>
            </>
          ) : (
            <>
              <span className="badge badge-red">{t('connections.link.otherDomain')}</span>
              <span className="rm-dest-n">
                {t('connections.link.otherDomainNote', { service: link.service })}
              </span>
            </>
          )}
        </div>
        <div className="mono rm-dest-url" data-testid="url">
          {url.href}
        </div>
        {!own && <p className="rm-p mb-3.5">{t('connections.link.noCredentials')}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={own ? 'btn btn-sm' : 'btn btn-sm btn-primary'}
            data-autofocus
            onClick={onClose}
          >
            {t('markdown.cancel')}
          </button>
          <button
            type="button"
            className={own ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
            onClick={open}
          >
            {own ? t('connections.link.open') : t('connections.link.openAnyway')}
          </button>
        </div>
      </div>
    </div>
  );
}
