import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useAuth } from '../auth/useAuth';
import { useSession } from '../auth/useSession';
import { canView } from '../layouts/navigation';
import { initialsFor } from '../lib/format';
import { useTheme } from '../preferences/theme';
import {
  ArrowRightIcon,
  BookOpenIcon,
  GlobeIcon,
  LockIcon,
  MoonIcon,
  MoreHorizontalIcon,
  SettingsIcon,
} from './icons';
import { SoonTag } from './Soon';

/**
 * Sidebar footer account button with its menu (design v9: shell.jsx), in "current availability"
 * mode: language and the getting-started tour are "Próximamente" (the app is Spanish-only and has
 * no tour); theme, Ajustes (admins) and sign-out work. "Contraseña y MFA" (design v10) only
 * explains that there is no self-service: forgot-password at sign-in, or an admin resets the MFA.
 * Identity and role come from GET /api/me (design oct 2026): «Admin», «Creador de agentes» or
 * «Usuario», with the account's groups listed below it in the menu. There is no role switcher
 * ("Ver como").
 * Keyboard: Enter/Space/ArrowDown open and focus the first item, arrows move (disabled items are
 * focusable, as in the APG menu pattern), Escape closes and returns focus to the button, Tab closes.
 */
export function UserMenu({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  /** Called after navigating from the menu (closes the off-canvas sidebar). */
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const { me } = useSession();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const roleId = useId();
  const groupsId = useId();
  const securityId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Design store.js ROLES: the label follows the permission groups (mango-admin, then
  // mango-agent-creator), as the API reports them: `is_admin` and the `CreateAgent` decision.
  // Display only; nothing is authorized here.
  const roleLabel = t(
    me.is_admin ? 'roles.admin' : me.can.create_agent ? 'roles.creator' : 'roles.user',
  );
  const displayName = me.name ?? me.email ?? me.user_id;

  const items = () => [
    ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => {
      list[(next + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        setOpen(false);
        break;
      case 'ArrowDown':
        event.preventDefault();
        focusAt(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusAt(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusAt(list.length - 1);
        break;
    }
  };

  return (
    <div ref={rootRef}>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={t('nav.accountMenu', { user: displayName })}
          aria-describedby={me.groups.length > 0 ? `${groupsId} ${securityId}` : securityId}
          className="menu sb-user-menu"
          onKeyDown={onMenuKeyDown}
        >
          <div className="sb-menu-head" aria-hidden="true">
            <p className="sb-menu-name m-0">{displayName}</p>
            {/* Without a display name the email is already the line above. */}
            {me.email && me.email !== displayName && (
              <p className="sb-menu-email m-0">{me.email}</p>
            )}
            <p className="sb-menu-role m-0">{roleLabel}</p>
            {/* Group names come from the verified token: data, rendered as text. */}
            {me.groups.length > 0 && (
              <ul id={groupsId} className="sb-menu-groups">
                <li className="sr-only">{t('nav.groupsLabel')}</li>
                {me.groups.map((group) => (
                  <li key={group} className="badge mono">
                    {group}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="menu-sep" role="separator" />
          {/* Informational only (no self-service, D20): read as the menu's description. */}
          <div id={securityId} className="sb-menu-note">
            <p className="sb-menu-note-title m-0">
              <LockIcon size={12} />
              {t('nav.accountSecurity.title')}
            </p>
            <p className="m-0">{t('nav.accountSecurity.hint')}</p>
          </div>
          <div className="menu-sep" role="separator" />
          <div
            role="menuitem"
            aria-disabled="true"
            tabIndex={-1}
            aria-label={t('soon.item', { label: t('nav.language') })}
            title={t('soon.title')}
            className="menu-item"
          >
            <GlobeIcon size={14} />
            <span className="flex-1">{t('nav.languageCurrent')}</span>
            <SoonTag />
          </div>
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            onClick={() => {
              toggleTheme();
              close(true);
            }}
          >
            <MoonIcon size={14} />
            <span className="flex-1">{t('nav.toggleTheme')}</span>
            <span className="sr-only">
              {theme === 'dark' ? t('nav.themeCurrentDark') : t('nav.themeCurrentLight')}
            </span>
          </button>
          <div
            role="menuitem"
            aria-disabled="true"
            tabIndex={-1}
            aria-label={t('soon.item', { label: t('nav.tour') })}
            title={t('soon.title')}
            className="menu-item"
          >
            <BookOpenIcon size={14} />
            <span className="flex-1">{t('nav.tour')}</span>
            <SoonTag />
          </div>
          {canView(me, 'settings') && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
                void navigate('/settings');
              }}
            >
              <SettingsIcon size={14} />
              <span className="flex-1">{t('nav.settings')}</span>
            </button>
          )}
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item danger"
            onClick={() => {
              setOpen(false);
              void logout();
            }}
          >
            <ArrowRightIcon size={14} />
            <span className="flex-1">{t('auth.signOut')}</span>
          </button>
        </div>
      )}
      <button
        ref={buttonRef}
        type="button"
        className="sb-user"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t('nav.accountMenu', { user: displayName })}
        aria-describedby={roleId}
        title={collapsed ? `${displayName} · ${roleLabel}` : undefined}
        onClick={() => {
          setOpen((value) => !value);
        }}
        onKeyDown={onButtonKeyDown}
      >
        <span className="sb-user-avatar" aria-hidden="true">
          {initialsFor(displayName)}
        </span>
        {/* The role line is the button's description (the aria-label replaces the visible text). */}
        {collapsed ? (
          <span id={roleId} className="sr-only">
            {roleLabel}
          </span>
        ) : (
          <>
            <span className="sb-user-text">
              <span className="sb-user-name" aria-hidden="true">
                {displayName}
              </span>
              <span id={roleId} className="sb-user-role">
                {roleLabel}
              </span>
            </span>
            <MoreHorizontalIcon size={14} className="shrink-0 text-muted" />
          </>
        )}
      </button>
    </div>
  );
}
