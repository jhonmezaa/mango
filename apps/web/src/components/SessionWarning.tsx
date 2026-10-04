import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../auth/useAuth';
import { ClockIcon } from './icons';

/** The notice shows this long before the session reaches its maximum duration (design). */
const WARN_MS = 10 * 60_000;
/** Longest delay `setTimeout` takes; a session never lasts that long (24 h at most). */
const MAX_DELAY_MS = 2_147_483_647;

/**
 * Band under the top of the screen 10 minutes before the session ends (design `.sess-warn`).
 * There is no «Extender»: the duration is a maximum. Shown once: «Entendido» hides it until
 * the next sign-in. Display only: mango-api is what ends the session.
 */
export function SessionWarning() {
  const { t } = useTranslation();
  const { sessionEndsAt, federated } = useAuth();
  // Minutes left when the notice came up, for the session it came up for.
  const [shown, setShown] = useState<{ endsAt: number; minutes: number } | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);

  useEffect(() => {
    if (sessionEndsAt === null) return;
    const show = () => {
      const left = sessionEndsAt - Date.now();
      if (left > 0) setShown({ endsAt: sessionEndsAt, minutes: Math.ceil(left / 60_000) });
    };
    const timer = setTimeout(
      show,
      Math.min(Math.max(sessionEndsAt - WARN_MS - Date.now(), 0), MAX_DELAY_MS),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [sessionEndsAt]);

  const visible = shown !== null && shown.endsAt === sessionEndsAt && dismissed !== sessionEndsAt;
  return (
    <div role="status">
      {visible ? (
        <div className="sess-warn">
          <ClockIcon size={14} />
          <span className="min-w-0 flex-1">
            <b>{t('app.sessionWarning.title', { count: shown.minutes })}</b>{' '}
            {t(federated ? 'app.sessionWarning.bodySso' : 'app.sessionWarning.body')}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setDismissed(sessionEndsAt);
            }}
          >
            {t('app.sessionWarning.dismiss')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
