import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { CheckIcon, ClockIcon, CopyIcon, X2Icon } from '../../components/icons';
import {
  daysUntil,
  formatDay,
  initialsOf,
  type Registration,
  type RemoteProfile,
  type RowStatus,
} from './model';

/** Design `RmTile`: the initials of the service, never an image from outside. */
export function RmTile({ profile, lg = false }: { profile: RemoteProfile; lg?: boolean }) {
  return (
    <span className={lg ? 'rm-tile lg' : 'rm-tile'} aria-hidden="true">
      {initialsOf(profile.name)}
    </span>
  );
}

/** Design `RmBadges`: read only, data leaves AWS and (in full) «Servicio externo». */
export function RmBadges({
  profile,
  compact = false,
}: {
  profile: RemoteProfile;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="badge" title={t('remoteMcp.badges.readOnlyTitle')}>
        {t('remoteMcp.badges.readOnly')}
      </span>
      {profile.data_leaves_aws ? (
        <span
          className="badge badge-amber"
          title={t('remoteMcp.badges.dataLeavesTitle', { operator: profile.operator })}
        >
          {t('remoteMcp.badges.dataLeaves')}
        </span>
      ) : null}
      {compact ? null : <span className="badge">{t('remoteMcp.badges.external')}</span>}
    </span>
  );
}

const STATUS_CLASS: Record<RowStatus, string> = {
  pending: 'badge badge-amber',
  creating: 'badge badge-blue',
  failed: 'badge badge-red',
  active: 'badge badge-green',
  secretExpired: 'badge badge-red',
  disabled: 'badge',
  rejected: 'badge badge-red',
  withdrawn: 'badge',
};

/** Design `RmStatus`. `null`: the profile has no registration («Sin habilitar»). */
export function RmStatus({ status }: { status: RowStatus | null }) {
  const { t } = useTranslation();
  if (status === null) return <span className="badge">{t('remoteMcp.status.none')}</span>;
  return (
    <span className={STATUS_CLASS[status]}>
      {status === 'creating' ? (
        <span className="g-spin mr-[5px] !h-[9px] !w-[9px]" aria-hidden="true" />
      ) : null}
      {t(`remoteMcp.status.${status}`)}
    </span>
  );
}

const COPIED_MS = 1600;

/**
 * Design `RmCopy`: the callback URL of AgentCore Identity (D93 (6)) as text, with «Copiar». It is
 * never a link: the administrator pastes it in Entra.
 */
export function RmCopy({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    const done = (next: 'copied' | 'failed') => {
      setState(next);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setState('idle');
      }, COPIED_MS);
    };
    // `clipboard` is missing outside a secure context (plain-HTTP dev hosts).
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) {
      done('failed');
      return;
    }
    clipboard.writeText(value).then(
      () => {
        done('copied');
      },
      () => {
        done('failed');
      },
    );
  };
  return (
    <div className="rm-copy">
      <div className="rm-copy-l">{label}</div>
      <div className="rm-copy-row">
        <code className="mono">{value}</code>
        <button type="button" className="btn btn-sm" onClick={copy}>
          {state === 'copied' ? (
            <>
              <CheckIcon size={11} /> {t('remoteMcp.copy.copied')}
            </>
          ) : (
            <>
              <CopyIcon size={11} /> {t('remoteMcp.copy.copy')}
            </>
          )}
        </button>
      </div>
      {state === 'failed' ? (
        <div className="rm-err" role="alert">
          {t('remoteMcp.copy.failed')}
        </div>
      ) : null}
    </div>
  );
}

/** Design `RmField`: label, control, and the error or the hint under it. */
export function RmField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <div className={error ? 'rm-field has-error' : 'rm-field'}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <div className="rm-err" role="alert" id={`${id}-err`}>
          {error}
        </div>
      ) : hint ? (
        <div className="rm-hint">{hint}</div>
      ) : null}
    </div>
  );
}

/** Design `SecretLine`: «Vence el … · en N días», amber within 30 days and red once expired. */
export function SecretLine({ registration }: { registration: Registration }) {
  const { t } = useTranslation();
  const expires = registration.secret_expires_on;
  if (!expires) return null;
  const days = daysUntil(expires) ?? 0;
  const level = registration.secret_level ?? 'ok';
  const color =
    level === 'expired'
      ? 'text-[var(--red)]'
      : level === 'ok'
        ? 'text-[var(--text)]'
        : 'text-[var(--amber)]';
  return (
    <span className={color}>
      {level === 'expired'
        ? t('remoteMcp.secret.expiredOn', { date: formatDay(expires) })
        : t('remoteMcp.secret.expiresOn', { date: formatDay(expires), count: days })}
    </span>
  );
}

/**
 * Design `SecretAlert`: the secret of the Entra app expires within 30 days or expired (D98 (7):
 * computed by the API on every read, no daily job, P-7).
 */
export function SecretAlert({
  registration,
  profile,
  onRotate,
}: {
  registration: Registration;
  profile: RemoteProfile;
  onRotate?: (() => void) | null;
}) {
  const { t } = useTranslation();
  const level = registration.secret_level;
  const expires = registration.secret_expires_on;
  if (registration.status !== 'active' || !expires || !level || level === 'ok') return null;
  const action = onRotate ? (
    <button type="button" className="btn btn-sm" onClick={onRotate}>
      {t('remoteMcp.row.rotate')}
    </button>
  ) : null;
  if (level === 'expired') {
    return (
      <div className="mc-alert red" role="alert">
        <X2Icon size={14} />
        <div className="flex-1">
          <b>{t('remoteMcp.secret.expiredTitle', { name: profile.name })}</b>
          <div>{t('remoteMcp.secret.expiredBody')}</div>
        </div>
        {action}
      </div>
    );
  }
  const days = daysUntil(expires) ?? 0;
  return (
    <div className="mc-alert amber" role="status">
      <ClockIcon size={14} />
      <div className="flex-1">
        <b>{t('remoteMcp.secret.soonTitle', { count: days })}</b>
        <div>{t('remoteMcp.secret.soonBody', { date: formatDay(expires) })}</div>
      </div>
      {action}
    </div>
  );
}
