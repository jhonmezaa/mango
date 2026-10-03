import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ErrorState } from '../components/ErrorState';
import { SearchIcon } from '../components/icons';
import { Topbar } from '../components/Topbar';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <>
      <Topbar crumbs={[t('notFound.title')]} />
      <div className="content flex">
        <ErrorState
          icon={SearchIcon}
          tone="muted"
          role="status"
          title={t('notFound.title')}
          description={t('notFound.description')}
          actions={
            <Link to="/" className="btn btn-sm">
              {t('notFound.back')}
            </Link>
          }
        />
      </div>
    </>
  );
}
