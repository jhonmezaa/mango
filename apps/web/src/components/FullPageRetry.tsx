import { useTranslation } from 'react-i18next';

import { FullPageMessage } from './FullPageMessage';
import { RefreshIcon } from './icons';

/**
 * The application could not start and nothing says the session ended (the renewal or the
 * profile did not answer): the generic error with «Reintentar», both texts the design already
 * has. The person is not sent to the sign-in form.
 */
export function FullPageRetry({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <FullPageMessage message={t('errors.generic')}>
      <button type="button" className="btn btn-sm btn-primary" onClick={onRetry}>
        <RefreshIcon size={11} />
        {t('errors.retry')}
      </button>
    </FullPageMessage>
  );
}
