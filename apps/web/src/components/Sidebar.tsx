import { useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';

import { chatPath, isChatable } from '../agents/agents';
import { useSession } from '../auth/useSession';
import {
  canView,
  isAvailable,
  NAV_GROUPS,
  NAV_PRIMARY,
  VIEW_ICONS,
  viewForPath,
  viewPath,
  type GroupId,
  type ViewKey,
} from '../layouts/navigation';
import { readPreference, writePreference } from '../preferences/storage';
import { useShell } from '../layouts/ShellContext';
import { ChevronDownIcon, ChevronLeftIcon, CloseIcon } from './icons';
import { agentIconStyle } from './marketplace/agentIcons';
import { SoonTag } from './Soon';
import { UserMenu } from './UserMenu';

const GROUPS_KEY = 'mango-sb-groups';
const GROUP_IDS: readonly GroupId[] = ['gov', 'build', 'ops'];
// Design (shell.jsx): Gobernanza starts open, the others follow the active view.
const DEFAULT_OPEN_GROUPS: Partial<Record<GroupId, boolean>> = { gov: true };

/** Open state of the collapsible nav groups, validated (storage content is untrusted). */
function readOpenGroups(): Partial<Record<GroupId, boolean>> {
  const raw = readPreference(GROUPS_KEY);
  if (raw === null) return DEFAULT_OPEN_GROUPS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_OPEN_GROUPS;
    const groups: Partial<Record<GroupId, boolean>> = {};
    for (const id of GROUP_IDS) {
      const value: unknown = (parsed as Record<string, unknown>)[id];
      if (typeof value === 'boolean') groups[id] = value;
    }
    return groups;
  } catch {
    return DEFAULT_OPEN_GROUPS;
  }
}

function groupOf(view: ViewKey | null): GroupId | null {
  if (!view) return null;
  return NAV_GROUPS.find((group) => group.items.includes(view))?.id ?? null;
}

export type SidebarMode = 'full' | 'rail' | 'mobile';

interface Props {
  mode: SidebarMode;
  collapsed: boolean;
  mobileOpen?: boolean;
  onToggleCollapsed: () => void;
  /** Called after any navigation (closes the off-canvas sidebar). */
  onNavigate: () => void;
  ref?: Ref<HTMLElement>;
}

interface NavItemProps {
  view: ViewKey;
  active: boolean;
  collapsed: boolean;
  sub?: boolean;
  onNavigate: () => void;
}

/** One destination: a link when it is available, a disabled "Próximamente" row otherwise. */
function NavItem({ view, active, collapsed, sub = false, onNavigate }: NavItemProps) {
  const { t } = useTranslation();
  const label = t(`nav.${view}`);
  const Icon = sub ? null : VIEW_ICONS[view];
  const className = sub ? 'sb-item sb-item-sub' : 'sb-item';
  if (!isAvailable(view)) {
    return (
      <span
        role="link"
        aria-disabled="true"
        className={`${className} is-soon`}
        aria-label={t('soon.item', { label })}
        title={t('soon.itemTitle', { label })}
      >
        {Icon && (
          <span className="sb-item-icon">
            <Icon size={16} />
          </span>
        )}
        {!collapsed && <span className="sb-item-label">{label}</span>}
        {!collapsed && <SoonTag />}
      </span>
    );
  }
  return (
    <Link
      to={viewPath(view)}
      className={className}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      onClick={onNavigate}
    >
      {Icon && (
        <span className="sb-item-icon">
          <Icon size={16} />
        </span>
      )}
      {!collapsed && <span className="sb-item-label">{label}</span>}
    </Link>
  );
}

/**
 * Sidebar (design: shell.jsx) in its "current availability" mode: every destination of the design,
 * with the ones that have no backend yet disabled as "Próximamente". Visibility follows the role
 * from GET /api/me (admin vs user); the API enforces authorization itself.
 *
 * Pinned agents are a preference of this browser: an id is only shown while the API lists that
 * agent for the user (published), and its name is rendered as text.
 */
export function Sidebar({
  mode,
  collapsed,
  mobileOpen = false,
  onToggleCollapsed,
  onNavigate,
  ref,
}: Props) {
  const { t } = useTranslation();
  const { me, agents } = useSession();
  const { pinnedAgentIds, togglePinnedAgent } = useShell();
  const { pathname } = useLocation();
  const [openGroups, setOpenGroups] = useState(readOpenGroups);

  const isCollapsed = mode !== 'mobile' && collapsed;
  const activeView = viewForPath(pathname);
  const activeGroup = groupOf(activeView);

  // Opening a view inside a group expands it once; the user can collapse it afterwards.
  const [lastGroup, setLastGroup] = useState(activeGroup);
  if (lastGroup !== activeGroup) {
    setLastGroup(activeGroup);
    if (activeGroup && openGroups[activeGroup] !== true) {
      const next = { ...openGroups, [activeGroup]: true };
      setOpenGroups(next);
      writePreference(GROUPS_KEY, JSON.stringify(next));
    }
  }

  const toggleGroup = (id: GroupId, isOpen: boolean) => {
    const next = { ...openGroups, [id]: !isOpen };
    setOpenGroups(next);
    writePreference(GROUPS_KEY, JSON.stringify(next));
  };

  const classes = ['sidebar'];
  if (isCollapsed) classes.push('sidebar-collapsed');
  if (mode === 'mobile') classes.push('sidebar-mobile');
  if (mode === 'mobile' && mobileOpen) classes.push('open');

  const primary = NAV_PRIMARY.filter((view) => canView(me, view));
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((view) => canView(me, view)),
  })).filter((group) => group.items.length > 0);
  const pinned = pinnedAgentIds.flatMap((id) => {
    const agent = agents?.find((item) => item.id === id);
    return agent && isChatable(agent) ? [agent] : [];
  });

  const workspaceContent = (
    <>
      <span className="sb-ws-logo" aria-hidden="true">
        m
      </span>
      {!isCollapsed && (
        <span className="sb-ws-text">
          <span className="sb-ws-name">{t('app.name')}</span>
          <span className="sb-ws-org">{t('nav.workspaceOrg')}</span>
        </span>
      )}
    </>
  );

  return (
    <aside
      ref={ref}
      className={classes.join(' ')}
      {...(mode === 'mobile'
        ? { role: 'dialog', 'aria-modal': mobileOpen, 'aria-label': t('nav.label') }
        : {})}
    >
      <div className="sb-top">
        {mode === 'rail' ? (
          <Link to="/" className="sb-workspace" aria-label={t('app.name')} onClick={onNavigate}>
            {workspaceContent}
          </Link>
        ) : (
          <button
            type="button"
            className="sb-workspace"
            onClick={mode === 'mobile' ? onNavigate : onToggleCollapsed}
            aria-expanded={mode === 'mobile' ? undefined : !isCollapsed}
            aria-label={
              mode === 'mobile'
                ? t('nav.closeMenu')
                : isCollapsed
                  ? t('nav.expand')
                  : t('nav.collapse')
            }
            title={
              mode === 'mobile' ? undefined : isCollapsed ? t('nav.expand') : t('nav.collapse')
            }
          >
            {workspaceContent}
            {!isCollapsed && <ChevronLeftIcon size={14} className="sb-ws-chevron" />}
          </button>
        )}
      </div>

      <nav className="sb-nav" aria-label={t('nav.label')}>
        <ul className="sb-group">
          {primary.map((view) => (
            <li key={view}>
              <NavItem
                view={view}
                active={activeView === view}
                collapsed={isCollapsed}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>

        {pinned.length > 0 ? (
          <ul className="sb-group" aria-label={t('nav.pinned')}>
            {isCollapsed ? (
              <li className="sb-divider" aria-hidden="true" />
            ) : (
              <li className="sb-label" aria-hidden="true">
                {t('nav.pinned')}
              </li>
            )}
            {pinned.map((agent) => {
              const { Icon } = agentIconStyle(agent.icon, agent.color);
              return (
                <li key={agent.id} className="sb-item sb-item-agent">
                  <Link
                    to={chatPath(agent.id)}
                    className="sb-item-main"
                    aria-label={t('nav.chatWith', { name: agent.name })}
                    title={isCollapsed ? agent.name : undefined}
                    onClick={onNavigate}
                  >
                    <span className="sb-item-icon">
                      <Icon size={16} />
                    </span>
                    {!isCollapsed && <span className="sb-item-label">{agent.name}</span>}
                  </Link>
                  {!isCollapsed && (
                    <button
                      type="button"
                      className="sb-pin-btn"
                      title={t('nav.unpin')}
                      aria-label={t('nav.unpinAgent', { name: agent.name })}
                      onClick={() => {
                        togglePinnedAgent(agent.id);
                      }}
                    >
                      <CloseIcon size={11} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}

        <section className="sb-group" aria-labelledby={isCollapsed ? undefined : 'sb-platform'}>
          {isCollapsed ? (
            <div className="sb-divider" aria-hidden="true" />
          ) : (
            <h2 id="sb-platform" className="sb-label">
              {t('nav.platform')}
            </h2>
          )}
          {isCollapsed ? (
            <ul className="m-0 list-none p-0" aria-label={t('nav.platform')}>
              {groups.flatMap((group) =>
                group.items.map((view) => (
                  <li key={view}>
                    <NavItem
                      view={view}
                      active={activeView === view}
                      collapsed
                      onNavigate={onNavigate}
                    />
                  </li>
                )),
              )}
            </ul>
          ) : (
            groups.map((group) => {
              const containsActive = activeGroup === group.id;
              const open = openGroups[group.id] ?? containsActive;
              const GroupIcon = group.icon;
              const listId = `sb-group-${group.id}`;
              return (
                <div key={group.id}>
                  <button
                    type="button"
                    className="sb-item sb-group-head"
                    aria-expanded={open}
                    aria-controls={listId}
                    {...(containsActive && !open ? { 'data-contains-active': '' } : {})}
                    onClick={() => {
                      toggleGroup(group.id, open);
                    }}
                  >
                    <span className="sb-item-icon">
                      <GroupIcon size={16} />
                    </span>
                    <span className="sb-item-label">{t(`nav.groups.${group.id}`)}</span>
                    <ChevronDownIcon size={13} className="sb-item-chevron" />
                  </button>
                  <ul id={listId} className="m-0 list-none p-0" hidden={!open}>
                    {group.items.map((view) => (
                      <li key={view}>
                        <NavItem
                          view={view}
                          active={activeView === view}
                          collapsed={false}
                          sub
                          onNavigate={onNavigate}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </section>
      </nav>

      <div className="sb-footer">
        <UserMenu collapsed={isCollapsed} onNavigate={onNavigate} />
      </div>
    </aside>
  );
}
