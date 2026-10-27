import { useTranslation } from 'react-i18next';

import { GlobeIcon } from '../../components/icons';

/** «Leyó {servicio}» (design remote-core.jsx `ReadMark`): the answer used remote content. */
export function ReadMark({ service }: { service: string }) {
  const { t } = useTranslation();
  return (
    <div className="rm-read" title={t('connections.read.title', { service })}>
      <GlobeIcon size={12} />
      <span>{t('connections.read.mark', { service })}</span>
      <span className="rm-read-s">{t('connections.read.sub')}</span>
    </div>
  );
}
