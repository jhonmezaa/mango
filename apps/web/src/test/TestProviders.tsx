import { useMemo, useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { readPinnedAgents, togglePinnedAgent } from '../agents/pinned';
import { AuthContext, type AuthContextValue } from '../auth/AuthContext';
import { SessionContext, type SessionContextValue } from '../auth/SessionContext';
import { ShellContext, type ShellContextValue } from '../layouts/ShellContext';
import { authValue, sessionValue } from './fixtures';

/** The part of the shell (AppLayout) that pages and the sidebar read: pinned agents. */
function TestShell({
  children,
  onOpenAgentPicker,
}: {
  children: ReactNode;
  onOpenAgentPicker: () => void;
}) {
  const [pinned, setPinned] = useState(readPinnedAgents);
  const shell = useMemo<ShellContextValue>(
    () => ({
      isMobile: false,
      openNav: () => undefined,
      pinnedAgentIds: pinned,
      togglePinnedAgent: (agentId) => {
        setPinned((current) => togglePinnedAgent(current, agentId));
      },
      openAgentPicker: onOpenAgentPicker,
    }),
    [pinned, onOpenAgentPicker],
  );
  return <ShellContext value={shell}>{children}</ShellContext>;
}

const noop = () => undefined;

export function TestProviders({
  children,
  session = sessionValue(),
  auth = authValue(),
  path = '/',
  onOpenAgentPicker = noop,
}: {
  children: ReactNode;
  session?: SessionContextValue;
  auth?: AuthContextValue;
  /** Where the router starts; an object carries router state too. */
  path?: string | { pathname: string; state: unknown };
  onOpenAgentPicker?: () => void;
}) {
  return (
    <AuthContext value={auth}>
      <SessionContext value={session}>
        <TestShell onOpenAgentPicker={onOpenAgentPicker}>
          <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
        </TestShell>
      </SessionContext>
    </AuthContext>
  );
}
