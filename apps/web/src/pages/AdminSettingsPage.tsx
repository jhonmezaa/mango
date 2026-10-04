import { useCallback, useEffect, useState, type ComponentType, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useSession } from '../auth/useSession';
import { AuthSettings } from '../components/account/AuthSettings';
import { InstallSection } from '../components/account/InstallSection';
import { AreasTab } from '../components/admin/AreasTab';
import { ConnectivityTab } from '../components/admin/ConnectivityTab';
import { Denied } from '../components/admin/govKit';
import {
  ActivityIcon,
  BotIcon,
  ChatIcon,
  EyeIcon,
  InfoIcon,
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
import { PeopleTab } from './settingsPeople/PeopleTab';

// Design order.
const TABS = ['general', 'people', 'groups', 'areas', 'conn'] as const;
type Tab = (typeof TABS)[number];

// General sections (design order). "Instalación" and "Autenticación" are available today.
const SECTIONS = [
  { key: 'install', Icon: InfoIcon },
  { key: 'org', Icon: OrgIcon },
  { key: 'auth', Icon: LockIcon },
  { key: 'conv', Icon: EyeIcon },
  { key: 'defaults', Icon: BotIcon },
  { key: 'billing', Icon: MoneyIcon },
  { key: 'notifications', Icon: ChatIcon },
  { key: 'observability', Icon: ActivityIcon },
  { key: 'branding', Icon: SunIcon },
] as const satisfies readonly { key: string; Icon: ComponentType<IconProps> }[];
type Section = 'install' | 'auth';
const isAvailable = (key: string): key is Section => key === 'install' || key === 'auth';

function GeneralTab({ onGoPeople }: { onGoPeople: () => void }) {
  const { t } = useTranslation();
  // Design: General opens on "Instalación".
  const [section, setSection] = useState<Section>('install');
  return (
    <div className="set-grid">
      <nav className="set-nav" aria-label={t('settings.general.sectionsLabel')}>
        {SECTIONS.map(({ key, Icon }) => {
          const label = t(`settings.general.sections.${key}`);
          return isAvailable(key) ? (
            <button
              key={key}
              type="button"
              className={section === key ? 'set-nav-item is-on' : 'set-nav-item'}
              aria-current={section === key ? 'page' : undefined}
              onClick={() => {
                setSection(key);
              }}
            >
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
        {section === 'install' ? <InstallSection /> : <AuthSettings onGoPeople={onGoPeople} />}
      </div>
    </div>
  );
}

/**
 * Ajustes (design settings.jsx in "disponibilidad actual"): General (Instalación and
 * Autenticación), Personas, Grupos, Áreas y OUs and Conectividad. Every call is authorized by
 * the API; `is_admin` only picks what to render.
 */
export function AdminSettingsPage() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const { notify, stack } = useToasts();
  // `null` until the person picks a tab: the page opens on General, or on Personas while the
  // installation has a single administrator (design: «recién instalada»).
  const [picked, setPicked] = useState<Tab | null>(null);
  const [onlyAdmin, setOnlyAdmin] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const tab: Tab = picked ?? (onlyAdmin ? 'people' : 'general');
  const setTab = setPicked;
  const onForbidden = useCallback(() => {
    setForbidden(true);
  }, []);
  const goAreas = useCallback(() => {
    setPicked('areas');
  }, []);
  const goPeople = useCallback(() => {
    setPicked('people');
  }, []);
  const isAdmin = me.is_admin;

  useEffect(() => {
    if (!isAdmin) return;
    const controller = new AbortController();
    // Only the count of administrators is used; a failure leaves the page on General.
    api.call('searchPeople', { body: {} }, { signal: controller.signal }).then(
      (people) => {
        if (!controller.signal.aborted) setOnlyAdmin(people.admins === 1);
      },
      () => undefined,
    );
    return () => {
      controller.abort();
    };
  }, [api, isAdmin]);

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
            <GeneralTab onGoPeople={goPeople} />
          </div>
        ) : (
          <div className="g-frame g-embed">
            <div
              className="g-embed-body"
              id="settings-panel"
              role="tabpanel"
              aria-labelledby={`settings-tab-${tab}`}
            >
              {tab === 'people' ? (
                <PeopleTab notify={notify} onForbidden={onForbidden} onGoTab={setTab} />
              ) : tab === 'groups' ? (
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
