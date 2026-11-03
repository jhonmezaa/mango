import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';

import { ApiError } from '../api/errors';

/**
 * Wait of a 429 that did not say how long (design chat.jsx round 34 `RateWait`). The edge
 * answers its blocks with `Retry-After: 180` and mango-api always sends its own; this is only
 * for an answer that lost the header.
 */
export const RATE_FALLBACK_S = 180;

/** When a request refused with a 429 may be sent again (client clock, ms); null otherwise. */
export function retryAtOf(error: unknown, now: number = Date.now()): number | null {
  if (!(error instanceof ApiError) || error.status !== 429) return null;
  return now + (error.retryAfter ?? RATE_FALLBACK_S) * 1000;
}

/** Seconds until `until` (ms), ticking each second while there are any left. */
export function useSecondsLeft(until: number): number {
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  const over = left === 0;
  useEffect(() => {
    if (over) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [over, until]);
  return left;
}

/** Design `fmtWait`: «2:58», «45 s», or «en 1 hora». */
export function formatWait(seconds: number, t: TFunction): string {
  if (seconds >= 3600) return t('rateWait.hours', { count: Math.ceil(seconds / 3600) });
  if (seconds > 60) {
    return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
  }
  return t('rateWait.secondsShort', { count: seconds });
}
