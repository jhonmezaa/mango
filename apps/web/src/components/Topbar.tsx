import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useNewConversation } from '../agents/useNewConversation';
import { useSession } from '../auth/useSession';
import { useShell } from '../layouts/ShellContext';
import { MenuIcon, PlusIcon, SearchIcon, SettingsIcon } from './icons';
import { Soon } from './Soon';

interface Props {
  /** Breadcrumb trail for assistive technology; the last item is the current page. */
  crumbs?: string[];
  /** Left content that replaces the search box (e.g. the chat agent header). */
  children?: ReactNode;
  /** Page actions, shown before the shell icons. */
  actions?: ReactNode;
  /** What the round "+" does on this page (the chat: a new conversation with its agent). */
  onCreate?: () => void;
}

/**
 * 64px borderless topbar (design: shell.jsx Topbar) in its "current availability" mode: search
 * (⌘K) is shown as "Próximamente", help and the approvals bell are not shown, the gear opens
 * Ajustes (admins only, from `is_admin` of GET /api/me; the API authorizes anyway) and the round
 * "+" starts a new conversation: with the agent the user picks (design `AgentPicker`).
 */
export function Topbar({ crumbs, children, actions, onCreate }: Props) {
  const { t } = useTranslation();
  const { isMobile, openNav } = useShell();
  const { me } = useSession();
  const navigate = useNavigate();
  const startConversation = useNewConversation();
  return (
    <header className="topbar">
      {crumbs && (
        <nav aria-label={t('nav.breadcrumb')} className="sr-only">
          <ol>
            {crumbs.map((crumb, index) => (
              <li key={crumb} aria-current={index === crumbs.length - 1 ? 'page' : undefined}>
                {crumb}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="topbar-left">
        {isMobile && (
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t('nav.openMenu')}
            onClick={openNav}
          >
            <MenuIcon size={16} />
          </button>
        )}
        {children ?? (
          <Soon name={t('soon.item', { label: t('nav.searchShort') })}>
            <span className="topbar-search">
              <SearchIcon size={15} />
              <span>{t('nav.searchShort')}</span>
              <span className="kbd">⌘K</span>
            </span>
          </Soon>
        )}
      </div>
      <div className="topbar-actions">
        {actions}
        {actions && <span className="topbar-sep" aria-hidden="true" />}
        {me.is_admin && (
          <button
            type="button"
            className="topbar-icon"
            aria-label={t('nav.settings')}
            title={t('nav.settings')}
            onClick={() => void navigate('/settings')}
          >
            <SettingsIcon size={17} />
          </button>
        )}
        <button
          type="button"
          className="topbar-create"
          aria-label={t('nav.newChat')}
          title={t('nav.newChat')}
          onClick={onCreate ?? startConversation}
        >
          <PlusIcon size={16} />
        </button>
      </div>
    </header>
  );
}
