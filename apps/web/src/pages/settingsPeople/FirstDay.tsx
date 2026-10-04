import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { CheckIcon } from '../../components/icons';
import type { FirstDayFacts } from './model';

interface Props extends FirstDayFacts {
  /** People who signed up and have no group yet. */
  waiting: number;
  /** Sign-up domains of the installation (public configuration). */
  domains: readonly string[];
  onInviteAdmin: () => void;
  onShowWaiting: () => void;
  onGoTab: (tab: 'areas' | 'groups') => void;
}

interface Step {
  key: 'admin' | 'areas' | 'groups' | 'access';
  done: boolean;
  status: string;
  action: ReactNode;
  /** It cannot be done alone: its changes are approved by a second administrator. */
  needsSecond?: boolean;
  alt?: string;
}

/**
 * «Primeros pasos de esta instalación» (design `FirstDay`). Every number comes from the API (the
 * directory, the mapping of areas and the registry of groups): nothing here is sample data.
 */
export function FirstDay({
  admins,
  withAccess,
  areas,
  ownGroups,
  waiting,
  domains,
  onInviteAdmin,
  onShowWaiting,
  onGoTab,
}: Props) {
  const { t } = useTranslation();
  const two = admins >= 2;
  const steps: Step[] = [
    {
      key: 'admin',
      done: two,
      status: two
        ? t('people.firstDay.admin.count', { count: admins })
        : t('people.firstDay.admin.onlyYou'),
      action: (
        <button type="button" className="btn btn-sm btn-primary" onClick={onInviteAdmin}>
          {t('people.firstDay.admin.action')}
        </button>
      ),
      alt: t('people.firstDay.admin.alt'),
    },
    {
      key: 'areas',
      done: areas !== null && areas > 0,
      status:
        areas === null
          ? t('people.firstDay.unknown')
          : areas > 0
            ? t('people.firstDay.areas.count', { count: areas })
            : t('people.firstDay.areas.none'),
      action: (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            onGoTab('areas');
          }}
        >
          {t('people.firstDay.areas.action')}
        </button>
      ),
      needsSecond: !two,
    },
    {
      key: 'groups',
      done: ownGroups !== null && ownGroups > 0,
      status:
        ownGroups === null
          ? t('people.firstDay.unknown')
          : ownGroups > 0
            ? t('people.firstDay.groups.count', { count: ownGroups })
            : t('people.firstDay.groups.none'),
      action: (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            onGoTab('groups');
          }}
        >
          {t('people.firstDay.groups.action')}
        </button>
      ),
      needsSecond: !two,
    },
    {
      key: 'access',
      done: withAccess > 0,
      status:
        withAccess > 0
          ? t('people.firstDay.access.count', { count: withAccess })
          : waiting > 0
            ? t('people.firstDay.access.waiting', { count: waiting })
            : t('people.firstDay.access.none'),
      action:
        waiting > 0 ? (
          <button type="button" className="btn btn-sm" onClick={onShowWaiting}>
            {t('people.firstDay.access.action')}
          </button>
        ) : null,
    },
  ];
  const left = steps.filter((step) => !step.done).length;

  return (
    <div className="card pp-first">
      <h2 className="g-sec-t">{t('people.firstDay.title')}</h2>
      <div className="g-sec-meta">{t('people.firstDay.left', { count: left })}</div>
      <ol className="pp-steps">
        {steps.map((step, index) => (
          <li key={step.key} className={step.done ? 'is-done' : ''}>
            <span className="pp-step-n" aria-hidden="true">
              {step.done ? <CheckIcon size={12} /> : index + 1}
            </span>
            <div className="pp-step-main">
              <div className="pp-step-head">
                <span className="pp-step-t">{t(`people.firstDay.${step.key}.title`)}</span>
                <span className={step.done ? 'badge badge-green' : 'badge'}>
                  {step.done ? t('people.firstDay.done') : ''}
                  {step.status}
                </span>
                {step.needsSecond && !step.done ? (
                  <span className="badge badge-amber">{t('people.firstDay.needsSecond')}</span>
                ) : null}
              </div>
              {step.done ? null : (
                <div className="mk-meta pp-step-d">{t(`people.firstDay.${step.key}.body`)}</div>
              )}
              {!step.done && step.alt ? <div className="mk-meta pp-step-d">{step.alt}</div> : null}
            </div>
            {!step.done && step.action ? <div className="pp-step-act">{step.action}</div> : null}
          </li>
        ))}
      </ol>
      <div className="pp-first-foot">
        {t('people.firstDay.foot.lead')}
        <Link className="sr-link" to="/budgets">
          {t('people.firstDay.foot.budgets')}
        </Link>
        {t('people.firstDay.foot.tail', { domains: domains.join(', ') })}
      </div>
    </div>
  );
}
