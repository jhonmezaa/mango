import { useTranslation } from 'react-i18next';

import { budgetPercent, budgetTone } from '../../lib/format';
import { usd } from '../admin/govFormat';
import { Badge } from '../Badge';
import { ArrowRightIcon } from '../icons';
import { AgentAvatar } from './AgentAvatar';
import { AgentMenu } from './AgentMenu';
import { StarIcon } from './icons';
import {
  isRetired,
  RELEASE_AGENT_CAPABILITIES,
  RELEASE_AGENT_ID,
  type Agent,
  type AgentBudget,
  type ModelNames,
} from './model';
import { ModelName } from './ModelName';

/** Capabilities a card shows before "+N" (design `caps.slice(0, 3)`). */
const SHOWN_CAPABILITIES = 3;

/** What a card, a table row and the detail panel need to act on one agent. */
export interface AgentItemProps {
  agent: Agent;
  /** Spend and limit of the month, when the design shows it; only admins receive it. */
  budget: AgentBudget | undefined;
  /**
   * Admin, or creator of this agent (`is_mine`): hints that only show or hide controls, the API
   * authorizes.
   */
  canManage: boolean;
  isAdmin: boolean;
  /** Model names for creators and admins; empty for the rest, who see the identifier. */
  modelNames: ModelNames;
  cloning: boolean;
  /** Pinned to the sidebar: a preference of this browser. */
  pinned: boolean;
  onTogglePin: (agent: Agent) => void;
  onOpen: (agent: Agent) => void;
  onChat: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
  onClone: (agent: Agent) => void;
  onRetire: (agent: Agent) => void;
}

/** Month spend against the limit (design `MkBudget`). */
export function AgentBudgetBar({
  budget,
  compact = false,
}: {
  budget: AgentBudget;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const percent = budgetPercent(budget.spent_usd, budget.limit_usd);
  const spent = usd(budget.spent_usd);
  const limit = usd(budget.limit_usd);
  return (
    <div className="mk-budget" title={t('marketplace.card.budget', { spent, limit })}>
      <div className="mk-bar-track">
        <span
          className={`mk-tone-${budgetTone(percent)}`}
          style={{ width: `${String(Math.min(percent, 100))}%` }}
        />
      </div>
      <span className="mono">{compact ? `${String(percent)}%` : `${spent} / ${limit}`}</span>
    </div>
  );
}

/** Menu of an agent, for whoever may manage it and while it is not retired. */
export function AgentActions(props: AgentItemProps) {
  const { agent, canManage, isAdmin, cloning, onEdit, onClone, onRetire } = props;
  if (!canManage || isRetired(agent)) return null;
  return (
    <AgentMenu
      name={agent.name}
      isAdmin={isAdmin}
      cloning={cloning}
      onEdit={() => {
        onEdit(agent);
      }}
      onClone={() => {
        onClone(agent);
      }}
      onRetire={() => {
        onRetire(agent);
      }}
    />
  );
}

/** Pin to the sidebar (design `PinBtn`). */
export function PinButton({ agent, pinned, onTogglePin }: AgentItemProps) {
  const { t } = useTranslation();
  if (isRetired(agent)) return null;
  return (
    <button
      type="button"
      className={pinned ? 'mk-icon is-pinned' : 'mk-icon'}
      title={pinned ? t('marketplace.pin.remove') : t('marketplace.pin.add')}
      aria-label={
        pinned
          ? t('marketplace.pin.removeAgent', { name: agent.name })
          : t('marketplace.pin.addAgent', { name: agent.name })
      }
      aria-pressed={pinned}
      onClick={(event) => {
        event.stopPropagation();
        onTogglePin(agent);
      }}
    >
      <StarIcon size={12} />
    </button>
  );
}

/** «Abrir chat»: a new conversation with the agent. The API authorizes every turn. */
export function ChatButton({
  agent,
  primary = false,
  onChat,
}: {
  agent: Agent;
  primary?: boolean;
  onChat: (agent: Agent) => void;
}) {
  const { t } = useTranslation();
  const label = t('marketplace.card.chat');
  const className = primary ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  return (
    <button
      type="button"
      className={className}
      onClick={(event) => {
        event.stopPropagation();
        onChat(agent);
      }}
    >
      {label}
      {primary ? null : <ArrowRightIcon size={11} />}
    </button>
  );
}

/**
 * How the removal of a retired agent's infrastructure goes (D48). The API only tells admins;
 * a finished removal shows nothing.
 */
export function CleanupBadge({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  if (agent.cleanup === 'running') {
    return <Badge tone="blue">{t('marketplace.cleanup.running')}</Badge>;
  }
  if (agent.cleanup === 'failed') {
    return <Badge tone="red">{t('marketplace.cleanup.failed')}</Badge>;
  }
  return null;
}

/**
 * Agent card (design marketplace.jsx `AgentCard`). Name, description and category come from the
 * agent's creator: they are rendered as text. The model is the identifier the API returns; its
 * name is only shown to creators and admins, who can read the catalog.
 */
export function AgentCard(props: AgentItemProps) {
  const { agent, budget, modelNames, onOpen, onChat } = props;
  const { t } = useTranslation();
  const retired = isRetired(agent);
  return (
    <div
      className={retired ? 'card mk-card is-archived' : 'card mk-card'}
      role="button"
      tabIndex={0}
      aria-label={t('marketplace.card.open', { name: agent.name })}
      onClick={() => {
        onOpen(agent);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(agent);
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar icon={agent.icon} color={agent.color} />
          <div className="min-w-0">
            <div className="mk-name">{agent.name}</div>
            <div className="mk-meta">
              {agent.category ? `${agent.category} · ` : null}
              <ModelName model={agent.model} names={modelNames} />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <PinButton {...props} />
          <AgentActions {...props} />
        </div>
      </div>
      <p className="mk-desc">{agent.description}</p>
      {agent.id === RELEASE_AGENT_ID ? (
        <ul className="flex flex-wrap gap-1" aria-label={t('agent.capabilitiesLabel')}>
          {RELEASE_AGENT_CAPABILITIES.slice(0, SHOWN_CAPABILITIES).map((key) => (
            <li key={key} className="badge mk-cap">
              {t(`agent.capabilities.${key}`)}
            </li>
          ))}
          <li className="badge mk-cap">
            +{RELEASE_AGENT_CAPABILITIES.length - SHOWN_CAPABILITIES}
          </li>
        </ul>
      ) : null}
      <div className="mk-foot">
        {budget ? <AgentBudgetBar budget={budget} compact /> : <span className="flex-1" />}
        {retired ? (
          <span className="flex items-center gap-1">
            <CleanupBadge agent={agent} />
            <Badge>{t('marketplace.card.retired')}</Badge>
          </span>
        ) : (
          <ChatButton agent={agent} onChat={onChat} />
        )}
      </div>
    </div>
  );
}
