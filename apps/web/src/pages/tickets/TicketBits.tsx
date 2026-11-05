import { useTranslation } from 'react-i18next';

import type { Agent } from '../../agents/agents';
import { agentIconStyle } from '../../components/marketplace/agentIcons';
import { initialsFor } from '../../lib/format';
import { personLabel, priorityWeight, type Person, type Priority, type Ticket } from './model';

/** Design `TkAvatar`: initials of the email, or a dashed circle when nobody has it. */
export function TicketAvatar({ person }: { person: Person | null }) {
  const { t } = useTranslation();
  if (!person) {
    return (
      <span
        className="tk-av empty"
        role="img"
        title={t('tickets.unassigned')}
        aria-label={t('tickets.unassigned')}
      />
    );
  }
  const label = personLabel(person);
  return (
    <span className="tk-av" title={label} aria-hidden="true">
      {initialsFor(label)}
    </span>
  );
}

/** Design `TkPrio`: three bars and, optionally, the label. */
export function TicketPriority({
  priority,
  label = true,
}: {
  priority: Priority;
  label?: boolean;
}) {
  const { t } = useTranslation();
  const name = t(`tickets.priority.${priority}`);
  return (
    <span className="tk-prio" title={t('tickets.priority.title', { priority: name.toLowerCase() })}>
      <span className="tk-bars" data-w={priorityWeight(priority)} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {label ? name : <span className="sr-only">{name}</span>}
    </span>
  );
}

/**
 * Design `TkAgent`: the agent's icon and name. The icon comes from the agents the person may use;
 * one they can no longer use keeps the name the API gave and the robot. Never a link.
 */
export function TicketAgent({
  ticket,
  agent,
  small = false,
}: {
  ticket: Pick<Ticket, 'agent_id' | 'agent_name'>;
  agent: Agent | undefined;
  small?: boolean;
}) {
  const name = agent?.name ?? ticket.agent_name;
  if (!ticket.agent_id || !name) return null;
  const { Icon, colorClass } = agentIconStyle(agent?.icon ?? 'Bot', agent?.color ?? 0);
  return (
    <span className="tk-agent">
      <span className={`tk-agent-ic ${colorClass}`} aria-hidden="true">
        <Icon size={10} />
      </span>
      <span className={small ? 'tk-agent-n is-sm' : 'tk-agent-n'}>{name}</span>
    </span>
  );
}
