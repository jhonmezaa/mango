import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ClockIcon } from './icons';
import { SoonTag } from './Soon';
import { Topbar } from './Topbar';

/** Page for a route of the design that is not available yet (design: avail.jsx SoonView). */
export function SoonView({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <>
      <Topbar crumbs={[label]} />
      <div className="content flex items-center justify-center">
        <div className="soon-view">
          <span className="soon-view-icon" aria-hidden="true">
            <ClockIcon size={20} />
          </span>
          <div className="flex items-center gap-2">
            <h1 className="soon-view-title">{label}</h1>
            <SoonTag />
          </div>
          <p className="soon-view-body">{t('soon.viewBody')}</p>
          <Link to="/" className="btn btn-sm">
            {t('soon.goToChat')}
          </Link>
        </div>
      </div>
    </>
  );
}
