import { useCallback } from 'react';
import { useNavigate } from 'react-router';

import { useSession } from '../auth/useSession';
import { useShell } from '../layouts/ShellContext';
import { chatPath, isChatable } from './agents';

/**
 * «Nueva conversación» outside a chat (design app.jsx `mango:pick-agent`): the user picks the
 * agent. With a single agent to choose from there is nothing to pick and its chat opens.
 */
export function useNewConversation(): () => void {
  const { agents } = useSession();
  const { openAgentPicker } = useShell();
  const navigate = useNavigate();
  return useCallback(() => {
    const usable = (agents ?? []).filter(isChatable);
    if (usable.length > 1) openAgentPicker();
    else void navigate(chatPath(usable[0]?.id ?? null));
  }, [agents, openAgentPicker, navigate]);
}
