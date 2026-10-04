import { useTranslation } from 'react-i18next';

import { hasNoAccess, type Person } from './model';

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
  return (
    <span className={`badge ${STATUS_BADGE[person.status]}`}>
      {t(`people.status.${person.status}`)}
    </span>
  );
}
