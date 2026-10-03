import { useTranslation } from 'react-i18next';

import { usd } from '../admin/govFormat';
import { AgentAvatar } from './AgentAvatar';
import { AgentActions, AgentBudgetBar, PinButton, type AgentItemProps } from './AgentCard';
import { isRetired, type Agent } from './model';
import { ModelName } from './ModelName';

interface Props {
  agents: readonly Agent[];
  itemProps: (agent: Agent) => AgentItemProps;
}

/** A column of the design without data behind it yet (status, tickets, spend for non-admins). */
function NoData() {
  const { t } = useTranslation();
  return (
    <span className="mk-meta">
      <span aria-hidden="true">{t('marketplace.table.noData')}</span>
      <span className="sr-only">{t('marketplace.table.noDataLabel')}</span>
    </span>
  );
}

/** List layout (design marketplace.jsx `AgentTable`). Agent texts are rendered as text. */
export function AgentTable({ agents, itemProps }: Props) {
  const { t } = useTranslation();
  return (
    <div className="card mk-table">
      <div className="mk-tr mk-th">
        <span>{t('marketplace.table.agent')}</span>
        <span>{t('marketplace.table.status')}</span>
        <span>{t('marketplace.table.model')}</span>
        <span>{t('marketplace.table.spend')}</span>
        <span className="text-right">{t('marketplace.table.tickets')}</span>
        <span />
      </div>
      {agents.map((agent) => {
        const props = itemProps(agent);
        const meta = [agent.category, agent.role].filter(Boolean).join(' · ');
        return (
          <div
            key={agent.id}
            className={isRetired(agent) ? 'mk-tr is-archived' : 'mk-tr'}
            role="button"
            tabIndex={0}
            aria-label={t('marketplace.card.open', { name: agent.name })}
            onClick={() => {
              props.onOpen(agent);
            }}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && event.key === 'Enter') {
                props.onOpen(agent);
              }
            }}
          >
            <div className="flex min-w-0 items-center gap-3">
              <AgentAvatar icon={agent.icon} color={agent.color} size="sm" />
              <div className="min-w-0">
                <div className="mk-name">{agent.name}</div>
                <div className="mk-meta">{meta}</div>
              </div>
            </div>
            <span>
              <NoData />
            </span>
            <span className="text-[12px] [overflow-wrap:anywhere]">
              <ModelName model={agent.model} names={props.modelNames} />
            </span>
            <div className="min-w-0">
              {props.budget ? (
                <>
                  <AgentBudgetBar budget={props.budget} compact />
                  <div className="mk-meta mono mt-[3px] text-[11px]">
                    {usd(props.budget.spent_usd)}
                  </div>
                </>
              ) : (
                <NoData />
              )}
            </div>
            <span className="text-right">
              <NoData />
            </span>
            <div className="flex items-center justify-end gap-1">
              <PinButton {...props} />
              <AgentActions {...props} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
