import type { Agent } from '../../agents/agents';
import { BotIcon } from '../icons';
import { agentIconStyle } from '../marketplace/agentIcons';

const SIZES = {
  sm: { className: 'agent-avatar agent-avatar-sm', icon: 13 },
  lg: { className: 'agent-avatar agent-avatar-lg', icon: 26 },
} as const;

interface Props {
  /** Null while the agent is unknown (loading, or no longer listed for the user). */
  agent: Pick<Agent, 'icon' | 'color'> | null;
  size: keyof typeof SIZES;
}

/**
 * Agent icon of the chat (design chat.jsx: 26px in the header and the history, 54px in the hero).
 * Icon and color are data of the agent: they pick an entry of a closed list, never markup.
 */
export function ChatAgentAvatar({ agent, size }: Props) {
  const { className, icon } = SIZES[size];
  if (!agent) {
    return (
      <span className={`${className} agent-avatar-unknown`} aria-hidden="true">
        <BotIcon size={icon} />
      </span>
    );
  }
  const { Icon, colorClass } = agentIconStyle(agent.icon, agent.color);
  return (
    <span className={`${className} ${colorClass}`} aria-hidden="true">
      <Icon size={icon} />
    </span>
  );
}
