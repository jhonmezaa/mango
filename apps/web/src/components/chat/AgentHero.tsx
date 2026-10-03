import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { serverCount, type Agent } from '../../agents/agents';
import { ActivityIcon, CommandIcon, MenuIcon, MoneyIcon, ZapIcon, type IconProps } from '../icons';
import { ChatAgentAvatar } from './ChatAgentAvatar';

type FinOpsPrompt = 'monthSpend' | 'topServices' | 'forecast' | 'anomalies';
type CapabilityKey = 'costs' | 'forecast' | 'anomalies' | 'savingsPlans' | 'areas';

// Design chat.jsx `suggestedPrompts` ("Disponible hoy"): only the release agent (FinOps) has
// questions of its own; every other agent shows none (no filler suggestions). `MenuIcon` is the
// design's `List` icon.
const RELEASE_AGENT_ID = 'finops';
const FINOPS_PROMPTS: { key: FinOpsPrompt; icon: ComponentType<IconProps> }[] = [
  { key: 'monthSpend', icon: MoneyIcon },
  { key: 'topServices', icon: MenuIcon },
  { key: 'forecast', icon: ActivityIcon },
  { key: 'anomalies', icon: ZapIcon },
];

// What the FinOps agent can query (connectors/cost-explorer tools), not marketing claims. An
// agent definition carries no capabilities, so other agents show none.
const FINOPS_CAPABILITIES: CapabilityKey[] = [
  'costs',
  'areas',
  'forecast',
  'anomalies',
  'savingsPlans',
];

interface Props {
  agent: Agent;
  disabled: boolean;
  onPrompt: (prompt: string) => void;
}

/**
 * Empty-conversation state (design: chat.jsx AgentHero). Name, description and category are
 * written by the agent's creator and rendered as text. There is no status dot: nothing reports
 * whether an agent is online.
 */
export function AgentHero({ agent, disabled, onPrompt }: Props) {
  const { t } = useTranslation();
  const isRelease = agent.id === RELEASE_AGENT_ID;
  const servers = serverCount(agent.tools);
  return (
    <div className="agent-hero">
      <div className="agent-hero-inner">
        <div className="mb-[18px] flex items-center gap-4">
          <ChatAgentAvatar agent={agent} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="agent-hero-name">{agent.name}</h1>
            {isRelease || agent.category ? (
              <p className="mt-0.5 text-[12.5px] text-muted">
                {isRelease ? t('agent.releaseTagline') : agent.category}
              </p>
            ) : null}
          </div>
        </div>
        {agent.description ? <p className="agent-hero-desc">{agent.description}</p> : null}
        <ul className="mb-7 flex flex-wrap gap-1.5" aria-label={t('agent.capabilitiesLabel')}>
          {isRelease
            ? FINOPS_CAPABILITIES.map((key) => (
                <li key={key} className="badge text-[11px]">
                  {t(`agent.capabilities.${key}`)}
                </li>
              ))
            : null}
          <li className="badge dim text-[11px]">
            <CommandIcon size={10} className="mr-1" />
            {t('agent.mcpServers', { count: servers })}
          </li>
        </ul>
        {isRelease ? (
          <>
            <h2 className="label mb-2.5">{t('chat.suggestions')}</h2>
            <ul className="suggestion-grid">
              {FINOPS_PROMPTS.map(({ key, icon: Icon }) => (
                <li key={key}>
                  <button
                    type="button"
                    className="card card-hover suggestion"
                    disabled={disabled}
                    onClick={() => {
                      onPrompt(t(`chat.prompts.${key}.prompt`));
                    }}
                  >
                    <Icon size={14} />
                    <span className="min-w-0 flex-1">
                      <span className="suggestion-title">{t(`chat.prompts.${key}.title`)}</span>
                      <span className="suggestion-sub">{t(`chat.prompts.${key}.sub`)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
