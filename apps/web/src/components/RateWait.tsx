import { useTranslation } from 'react-i18next';

import { RefreshIcon } from './icons';
import { formatWait, useSecondsLeft } from './rateLimitWait';

/** «Puedes volver a intentarlo en {N minutos | unos segundos}.», then «Ya puedes…». */
export function RateWaitLine({ until }: { until: number }) {
  const { t } = useTranslation();
  const left = useSecondsLeft(until);
  if (left === 0) return <>{t('rateWait.ready')}</>;
  return (
    <>
      {left > 60 ? t('rateWait.minutes', { count: Math.ceil(left / 60) }) : t('rateWait.seconds')}
    </>
  );
}

/**
 * «Reintentar» of a 429: disabled with the countdown, «Reintentar en 2:58», and enabled only at
 * zero, so a retry does not count again (design round 34).
 */
export function RateWaitButton({
  until,
  onRetry,
  className = 'btn btn-sm',
}: {
  until: number;
  onRetry: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const left = useSecondsLeft(until);
  if (left > 0) {
    return (
      <button type="button" className={className} disabled title={t('rateWait.hint')}>
        {t('rateWait.retryIn', { wait: formatWait(left, t) })}
      </button>
    );
  }
  return (
    <button type="button" className={className} onClick={onRetry}>
      <RefreshIcon size={11} />
      {t('errors.retry')}
    </button>
  );
}
