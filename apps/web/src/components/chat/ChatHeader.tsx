import { useTranslation } from 'react-i18next';

import { serverCount, type Agent } from '../../agents/agents';
import { ActivityIcon, ChatIcon, CloudIcon, MoreIcon, SkillIcon } from '../icons';
import { Soon } from '../Soon';
import { Topbar } from '../Topbar';
import { ChatAgentAvatar } from './ChatAgentAvatar';
import { ModelSwitcher } from './ModelSwitcher';

// Skills are not part of an agent yet (D38): the count is only shown inside the "Próximamente"
// trigger of the design.
const SKILL_COUNT = 0;

interface Props {
  /** The agent of the conversation; null while it is not known. */
  agent: Agent | null;
  /** Model of the next turn, one of the agent's allowed models. */
  model: string | null;
  onModelChange: (model: string) => void;
  /** The hero shows the agent name as the page heading; otherwise the header does. */
  headingLevel: 'h1' | 'p';
  observe: boolean;
  onToggleObserve: () => void;
  /** A new conversation with this same agent (design `onNewChat`). */
  onNewChat: () => void;
  /** Present below 1100px, where the conversation list is a drawer instead of a column. */
  onOpenConversations?: (() => void) | undefined;
}

/**
 * Chat header (design: chat.jsx ChatHeader): the agent of the conversation and the model
 * switcher among the models its approved version allows. The API exposes no thread cost or
 * skills, so the cost, the skills/MCP popover and "Más opciones" are "Próximamente"; "Observar"
 * works on the live stream. It is rendered inside the shell Topbar, which supplies the rest of
 * the design's chat header exactly once: the menu button (≤900px), the separator, the gear
 * (admins only) and the round "+" (new conversation with this agent). The "Próximamente"
 * controls hide at 1000, 860 and 640px like the design (chat.css). Like the hero, it shows no
 * «En línea» dot: the API does not say whether an agent is online. The agent's name comes from
 * its creator and is rendered as text.
 */
export function ChatHeader({
  agent,
  model,
  onModelChange,
  headingLevel: Heading,
  observe,
  onToggleObserve,
  onNewChat,
  onOpenConversations,
}: Props) {
  const { t } = useTranslation();
  const observeLabel = observe ? t('chat.header.observeOff') : t('chat.header.observeOn');
  const name = agent?.name ?? t('chat.agentUnknown');
  const models = agent
    ? agent.allowed_models.length > 0
      ? agent.allowed_models
      : [agent.model]
    : [];
  return (
    <Topbar
      crumbs={[t('nav.chat'), name]}
      onCreate={onNewChat}
      actions={
        <>
          <Soon name={t('soon.item', { label: t('chat.header.cost') })} className="chat-soon-cost">
            <span className="chat-cost mono">{t('chat.header.costEmpty')}</span>
          </Soon>
          <button
            type="button"
            className={
              observe ? 'btn btn-sm btn-icon btn-primary' : 'btn btn-sm btn-icon btn-ghost'
            }
            title={observeLabel}
            aria-label={t('chat.header.observe')}
            aria-pressed={observe}
            onClick={onToggleObserve}
          >
            <ActivityIcon size={12} />
          </button>
          <Soon
            name={t('soon.item', { label: t('chat.header.tools') })}
            className="chat-soon-tools"
          >
            <span className="btn btn-sm">
              <SkillIcon size={11} /> {SKILL_COUNT} · <CloudIcon size={11} />{' '}
              {agent ? serverCount(agent.tools) : 0}
            </span>
          </Soon>
          <Soon name={t('soon.item', { label: t('chat.header.more') })} className="chat-soon-more">
            <span className="btn btn-sm btn-ghost btn-icon">
              <MoreIcon size={13} />
            </span>
          </Soon>
        </>
      }
    >
      <div className="chat-head">
        {onOpenConversations && (
          <button
            type="button"
            className="btn btn-sm shrink-0"
            aria-label={t('chat.conversations')}
            title={t('chat.conversations')}
            onClick={onOpenConversations}
          >
            <ChatIcon size={13} />
            <span className="chat-conv-label">{t('chat.conversations')}</span>
          </button>
        )}
        <ChatAgentAvatar agent={agent} size="sm" />
        <div className="min-w-0">
          <Heading className="chat-head-name">{name}</Heading>
          {agent ? (
            <div className="chat-head-sub">
              {agent.status === 'retired' ? <span>{t('chat.agentRetired')}</span> : null}
              {model ? (
                <>
                  {agent.status === 'retired' ? <span aria-hidden="true">·</span> : null}
                  <ModelSwitcher
                    models={models}
                    value={model}
                    disabled={agent.status === 'retired'}
                    onChange={onModelChange}
                  />
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Topbar>
  );
}
