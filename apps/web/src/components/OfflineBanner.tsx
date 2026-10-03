import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

export function OfflineBanner() {
  const { t } = useTranslation();
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  return (
    <div role="status" aria-live="polite">
      {!online && <p className="offline-banner">{t('app.offline')}</p>}
    </div>
  );
}
