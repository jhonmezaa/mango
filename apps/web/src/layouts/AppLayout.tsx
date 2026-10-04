import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation, useNavigate } from 'react-router';

import { chatPath, type Agent } from '../agents/agents';
import { readPinnedAgents, togglePinnedAgent } from '../agents/pinned';
import { useSession } from '../auth/useSession';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { OfflineBanner } from '../components/OfflineBanner';
import { SessionWarning } from '../components/SessionWarning';
import { Sidebar, type SidebarMode } from '../components/Sidebar';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { readPreference, writePreference } from '../preferences/storage';
import { ShellContext, type ShellContextValue } from './ShellContext';

const COLLAPSED_KEY = 'mango-sb-collapsed';
const NO_AGENTS: readonly Agent[] = [];

// Only opened on demand («Nueva conversación»): it stays out of the main chunk.
const AgentPicker = lazy(() =>
  import('../components/agents/AgentPicker').then((module) => ({ default: module.AgentPicker })),
);

export function AppLayout() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { me, agents, conversations } = useSession();
  const isNarrow = useMediaQuery('(max-width: 1200px)');
  const isMobile = useMediaQuery('(max-width: 900px)');
  const [collapsed, setCollapsed] = useState(() => readPreference(COLLAPSED_KEY) === '1');
  const [mobileOpen, setMobileOpen] = useState(false);
  // Leaving the mobile breakpoint closes the drawer, so it does not reopen on the way back.
  const [wasMobile, setWasMobile] = useState(isMobile);
  if (wasMobile !== isMobile) {
    setWasMobile(isMobile);
    setMobileOpen(false);
  }

  const mode: SidebarMode = isMobile ? 'mobile' : isNarrow ? 'rail' : 'full';
  const drawerOpen = mode === 'mobile' && mobileOpen;

  const closeNav = useCallback(() => {
    setMobileOpen(false);
  }, []);
  const sidebarRef = useFocusTrap<HTMLElement>(drawerOpen, closeNav);

  // Pinned agents: a UI preference of this browser (design app.jsx `pinnedIds`).
  const [pinnedAgentIds, setPinnedAgentIds] = useState(readPinnedAgents);
  const togglePinned = useCallback((agentId: string) => {
    setPinnedAgentIds((current) => togglePinnedAgent(current, agentId));
  }, []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const closePicker = useCallback(() => {
    setPickerOpen(false);
  }, []);
  const recentAgentIds = useMemo(
    () => (conversations ?? []).map((item) => item.agent_id),
    [conversations],
  );

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    writePreference(COLLAPSED_KEY, next ? '1' : '0');
  };

  const shell = useMemo<ShellContextValue>(
    () => ({
      isMobile,
      openNav: () => {
        setMobileOpen(true);
      },
      pinnedAgentIds,
      togglePinnedAgent: togglePinned,
      openAgentPicker: () => {
        setPickerOpen(true);
      },
    }),
    [isMobile, pinnedAgentIds, togglePinned],
  );

  const classes = ['app'];
  if (mode === 'mobile') classes.push('app-mobile');
  else if (mode === 'rail' || collapsed) classes.push('app-sb-collapsed');

  return (
    <ShellContext value={shell}>
      <a href="#main" className="skip-link">
        {t('app.skipToContent')}
      </a>
      <div className={classes.join(' ')}>
        {drawerOpen && <div className="sb-scrim" aria-hidden="true" onClick={closeNav} />}
        <Sidebar
          ref={sidebarRef}
          mode={mode}
          collapsed={mode === 'rail' || collapsed}
          mobileOpen={mobileOpen}
          onToggleCollapsed={toggleCollapsed}
          onNavigate={closeNav}
        />
        <main id="main" tabIndex={-1} className="main">
          <OfflineBanner />
          <SessionWarning />
          {/* Every routed page, admin screens included: a crash keeps the shell usable. */}
          <ErrorBoundary resetKey={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      {pickerOpen ? (
        <Suspense fallback={null}>
          <AgentPicker
            agents={agents ?? NO_AGENTS}
            recentAgentIds={recentAgentIds}
            canCreate={me.can.create_agent}
            onPick={(agent) => {
              setPickerOpen(false);
              void navigate(chatPath(agent.id));
            }}
            onCreate={() => {
              setPickerOpen(false);
              void navigate('/admin');
            }}
            onMarketplace={() => {
              setPickerOpen(false);
              void navigate('/marketplace');
            }}
            onClose={closePicker}
          />
        </Suspense>
      ) : null}
    </ShellContext>
  );
}
