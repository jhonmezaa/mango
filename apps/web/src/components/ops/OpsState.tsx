import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { LockIcon, RefreshIcon, WarnIcon } from '../icons';

export type OpsView = 'costs' | 'observability' | 'evals' | 'tickets';
export type OpsStateKind = 'loading' | 'error' | 'empty' | 'denied';

interface Props {
  view: OpsView;
  kind: OpsStateKind;
  /** «Reintentar» of the error state. */
  onRetry?: () => void;
  /** Action under the empty state's text (e.g. «Nuevo ticket»). */
  action?: ReactNode;
}

/**
 * Loading, error, empty and 403 states of Costos, Observabilidad, Evals and Tickets
 * (design round 37, ops-states.jsx `OpsState`). The 403 only explains who sees the view: the
 * server decides access, this is what the person sees when it says no.
 */
export function OpsState({ view, kind, onRetry, action }: Props) {
  const { t } = useTranslation();
  const label = t(`ops.label.${view}`);
  if (kind === 'loading') {
    return (
      <div className="mk-empty" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span className="mk-meta">{t(`ops.loading.${view}`)}</span>
      </div>
    );
  }
  if (kind === 'error') {
    return (
      <div className="mk-empty" role="alert">
        <WarnIcon size={18} className="ops-state-warn" />
        <div className="ops-state-t">{t('ops.error.title', { view: label })}</div>
        <div className="mk-meta">{t('ops.error.body')}</div>
        {onRetry && (
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            <RefreshIcon size={12} /> {t('common.retry')}
          </button>
        )}
      </div>
    );
  }
  if (kind === 'denied') {
    return (
      <div className="mk-empty">
        <LockIcon size={18} className="ops-state-lock" />
        <div className="ops-state-t">{t('ops.denied.title', { view: label })}</div>
        <div className="mk-meta ops-state-d">{t(`ops.denied.${view}`)}</div>
        <Link className="btn btn-sm" to="/">
          {t('ops.denied.toChat')}
        </Link>
      </div>
    );
  }
  return (
    <div className="mk-empty">
      <div className="ops-state-t">{t(`ops.empty.${view}.title`)}</div>
      <div className="mk-meta ops-state-d">{t(`ops.empty.${view}.body`)}</div>
      {action}
    </div>
  );
}
