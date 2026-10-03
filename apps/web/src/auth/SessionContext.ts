import { createContext } from 'react';

import type { Agent } from '../agents/agents';
import type { ApiClient } from '../api/client';
import type { ConversationSummary, Me } from '../api/schemas';
import type { RuntimeConfig } from '../config/runtimeConfig';

export interface SessionContextValue {
  api: ApiClient;
  /** Public installation settings (`config.json`), e.g. for Ajustes › Autenticación. */
  config: RuntimeConfig;
  me: Me;
  conversations: ConversationSummary[] | null;
  conversationsError: boolean;
  reloadConversations: () => void;
  /** Agents the user may use (GET /api/agents: published and retired); null while loading. */
  agents: Agent[] | null;
  agentsError: boolean;
  reloadAgents: () => void;
}

export const SessionContext = createContext<SessionContextValue | null>(null);
