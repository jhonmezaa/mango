import { createContext, useContext } from 'react';

export interface ShellContextValue {
  /** Below 900px the sidebar is off-canvas and the topbar shows a menu button. */
  isMobile: boolean;
  openNav: () => void;
  /** Agents pinned to the sidebar (a preference of this browser; ids, in pin order). */
  pinnedAgentIds: readonly string[];
  togglePinnedAgent: (agentId: string) => void;
  /** Opens the agent picker (design `AgentPicker`) to start a conversation. */
  openAgentPicker: () => void;
  /** Unread notices of the Bandeja (D83), as the API last counted them; null until known. */
  inboxUnread: number | null;
  /** The Bandeja tells the shell the count its own responses carry. */
  setInboxUnread: (count: number) => void;
}

export const ShellContext = createContext<ShellContextValue>({
  isMobile: false,
  openNav: () => undefined,
  pinnedAgentIds: [],
  togglePinnedAgent: () => undefined,
  openAgentPicker: () => undefined,
  inboxUnread: null,
  setInboxUnread: () => undefined,
});

export function useShell(): ShellContextValue {
  return useContext(ShellContext);
}
