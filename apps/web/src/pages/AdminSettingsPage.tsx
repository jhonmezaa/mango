import { useCallback, useState, type ComponentType, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useSession } from '../auth/useSession';
import { AuthSettings } from '../components/account/AuthSettings';
import { AreasTab } from '../components/admin/AreasTab';
import { ConnectivityTab } from '../components/admin/ConnectivityTab';
import { Denied } from '../components/admin/govKit';
import {
  ActivityIcon,
  BotIcon,
  ChatIcon,
  EyeIcon,
  LockIcon,
  MoneyIcon,
  OrgIcon,
  SunIcon,
  type IconProps,
} from '../components/icons';
import { useToasts } from '../components/admin/useToasts';
import { Soon } from '../components/Soon';
import { Topbar } from '../components/Topbar';
import { GroupsTab } from './settingsGroups/GroupsTab';

// Design order.
const TABS = ['general', 'groups', 'areas', 'conn'] as const;
type Tab = (typeof TABS)[number];

// General sections (design order). Only "Autenticación" is available today.
const SECTIONS: readonly { key: string; Icon: ComponentType<IconProps> }[] = [
  { key: 'org', Icon: OrgIcon },
  { key: 'auth', Icon: LockIcon },
  { key: 'conv', Icon: EyeIcon },
  { key: 'defaults', Icon: BotIcon },
  { key: 'billing', Icon: MoneyIcon },
  { key: 'notifications', Icon: ChatIcon },
  { key: 'observability', Icon: ActivityIcon },
  { key: 'branding', Icon: SunIcon },
];

function GeneralTab({ notify }: { notify: (message: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="set-grid">
      <nav className="set-nav" aria-label={t('settings.general.sectionsLabel')}>
        {SECTIONS.map(({ key, Icon }) => {
          const label = t(`settings.general.sections.${key}` as 'settings.general.sections.auth');
          return key === 'auth' ? (
            <button key={key} type="button" className="set-nav-item is-on" aria-current="page">
              <Icon size={14} />
              <span>{label}</span>
            </button>
          ) : (
            <Soon key={key} name={label} block>
              <button type="button" className="set-nav-item" tabIndex={-1}>
                <Icon size={14} />
                <span>{label}</span>
              </button>
            </Soon>
          );
        })}
      </nav>
      <div className="set-body">
        <AuthSettings notify={notify} />
      </div>
    </div>
  );
}

/**
 * Ajustes (design settings.jsx in "disponibilidad actual"): General (only Autenticación),
 * Grupos, Áreas y OUs and Conectividad. Every call is authorized by the API; `is_admin` only picks what
 * to render.
 */
export function AdminSettingsPage() {
  const { t } = useTranslation();
  const { me } = useSession();
  const { notify, stack } = useToasts();
  const [tab, setTab] = useState<Tab>('general');
  const [forbidden, setForbidden] = useState(false);
  const onForbidden = useCallback(() => {
    setForbidden(true);
  }, []);
  const goAreas = useCallback(() => {
    setTab('areas');
  }, []);

  const crumbs = [t('settings.crumb')];
  if (!me.is_admin || forbidden) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="content">
          <Denied />
        </div>
      </>
    );
  }

  // Arrow keys move between the tabs (WAI-ARIA tabs pattern).
  const onTabKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = TABS.indexOf(tab);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = TABS[(index + step + TABS.length) % TABS.length];
    if (next) {
      setTab(next);
      document.getElementById(`settings-tab-${next}`)?.focus();
    }
  };

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="content overflow-auto">
        <div className="page-head">
          <h1 className="page-title">{t('settings.title')}</h1>
          <p className="page-subtitle">{t('settings.subtitle')}</p>
        </div>
        <div className="g-frame g-embed g-tabs-wrap">
          <div
            className="g-tabs"
            role="tablist"
            aria-label={t('settings.tabsLabel')}
            onKeyDown={onTabKey}
          >
            {TABS.map((key) => (
              <button
                key={key}
                id={`settings-tab-${key}`}
                type="button"
                role="tab"
                aria-selected={tab === key}
                aria-controls="settings-panel"
                tabIndex={tab === key ? 0 : -1}
                className={tab === key ? 'is-on' : ''}
                onClick={() => {
                  setTab(key);
                }}
              >
                {t(`settings.tabs.${key}`)}
              </button>
            ))}
          </div>
        </div>
        {tab === 'general' ? (
          <div id="settings-panel" role="tabpanel" aria-labelledby="settings-tab-general">
            <GeneralTab notify={notify} />
          </div>
        ) : (
          <div className="g-frame g-embed">
            <div
              className="g-embed-body"
              id="settings-panel"
              role="tabpanel"
              aria-labelledby={`settings-tab-${tab}`}
            >
              {tab === 'groups' ? (
                <GroupsTab notify={notify} onForbidden={onForbidden} onGoAreas={goAreas} />
              ) : tab === 'areas' ? (
                <AreasTab notify={notify} onForbidden={onForbidden} />
              ) : (
                <ConnectivityTab />
              )}
            </div>
          </div>
        )}
      </div>
      {stack}
    </>
  );
}
