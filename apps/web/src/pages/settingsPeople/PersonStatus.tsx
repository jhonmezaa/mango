import { useTranslation } from 'react-i18next';

import { areasOf, cannotEnter, hasNoAccess, type Person } from './model';

/** Design `STATUS`. */
const STATUS_BADGE: Record<Person['status'], string> = {
  active: '',
  invited: 'badge-blue',
  disabled: 'badge-red',
};

/** Design `StatusBadge`: «Sin acceso» is an active person without groups. */
export function PersonStatusBadge({ person }: { person: Person }) {
  const { t } = useTranslation();
  if (hasNoAccess(person)) {
    return (
      <span className="badge badge-amber" title={t('people.status.noAccessTitle')}>
        {t('people.status.noAccess')}
      </span>
    );
  }
  // Design: a bu-lead Mango refuses at sign-in (403 `area_required`, D60 (10)).
  if (cannotEnter(person)) {
    const count = areasOf(person.groups).length;
    return (
      <span
        className="badge badge-amber"
        title={count ? t('people.status.areasTitle', { count }) : t('people.status.noAreaTitle')}
      >
        {count ? t('people.status.areas', { count }) : t('people.status.noArea')}
      </span>
    );
  }
  return (
    <span className={`badge ${STATUS_BADGE[person.status]}`}>
      {t(`people.status.${person.status}`)}
    </span>
  );
}
