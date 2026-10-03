import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { budgetPercent, budgetTone } from '../../lib/format';
import { usd } from '../admin/govFormat';
import { Alert } from '../Alert';
import { Badge } from '../Badge';
import { EditIcon, X2Icon } from '../icons';
import { SidePanel } from '../SidePanel';
import { Soon } from '../Soon';
import { AgentAvatar } from './AgentAvatar';
import { ChatButton, type AgentItemProps } from './AgentCard';
import { ArchiveIcon, ShareIcon, StarIcon } from './icons';
import { isRetired, ROOT_SUPERVISOR, toolsByServer, type Agent } from './model';
import { ModelName } from './ModelName';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mk-sec">
      <h3 className="mk-sec-t">{title}</h3>
      {children}
    </section>
  );
}

interface Props extends AgentItemProps {
  /** The agents the user can see, to name the supervisor. */
  agents: readonly Agent[];
  onClose: () => void;
}

/**
 * Detail of an agent (design marketplace.jsx `AgentDetail`). Share is "Próximamente": who an
 * agent is shared with changes in the Agent Builder, with a new version. A retired agent shows
 * its reason and, to admins, how the removal of its infrastructure goes (D48). Every text of the
 * agent is rendered as text.
 */
export function AgentDetail({
  agent,
  agents,
  budget,
  canManage,
  modelNames,
  pinned,
  onChat,
  onTogglePin,
  onEdit,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const retired = isRetired(agent);
  const servers = toolsByServer(agent.tools);
  const unavailable = new Set(agent.unavailable_tools);
  const models = agent.allowed_models.length > 0 ? agent.allowed_models : [agent.model];
  const supervisor =
    agent.reports_to === ROOT_SUPERVISOR
      ? t('marketplace.detail.platform')
      : (agents.find((other) => other.id === agent.reports_to)?.name ??
        t('marketplace.detail.unknown'));
  const percent = budget ? budgetPercent(budget.spent_usd, budget.limit_usd) : 0;

  return (
    <SidePanel
      title={agent.name}
      lead={<AgentAvatar icon={agent.icon} color={agent.color} size="lg" />}
      meta={
        <>
          {agent.category ? <span className="mk-meta">{agent.category}</span> : null}
          {retired ? <Badge>{t('marketplace.card.retired')}</Badge> : null}
        </>
      }
      onClose={onClose}
    >
      <p className="mk-detail-desc">{agent.description}</p>
      <div className="flex flex-wrap gap-2">
        {retired ? (
          <div className="grid w-full gap-2">
            <div className="sh-note">
              <ArchiveIcon size={12} />
              <span>
                {t('marketplace.detail.retiredNote', { reason: agent.retire_reason ?? '' })}
              </span>
            </div>
            {agent.cleanup === 'running' ? (
              <Alert role="status" icon={<span className="g-spin" aria-hidden="true" />}>
                {t('marketplace.cleanup.runningBody')}
              </Alert>
            ) : agent.cleanup === 'failed' ? (
              <Alert tone="red" role="alert" icon={<X2Icon size={14} />}>
                <b>{t('marketplace.cleanup.failedLead')}</b> {t('marketplace.cleanup.failedBody')}
              </Alert>
            ) : null}
          </div>
        ) : (
          <>
            <ChatButton agent={agent} primary onChat={onChat} />
            <button
              type="button"
              className={pinned ? 'btn btn-sm mk-pinned-on' : 'btn btn-sm'}
              aria-pressed={pinned}
              onClick={() => {
                onTogglePin(agent);
              }}
            >
              <StarIcon size={12} />{' '}
              {pinned ? t('marketplace.detail.pinned') : t('marketplace.detail.pin')}
            </button>
            <Soon name={t('soon.item', { label: t('marketplace.detail.share') })}>
              <button type="button" className="btn btn-sm" tabIndex={-1}>
                <ShareIcon size={12} /> {t('marketplace.detail.share')}
              </button>
            </Soon>
            {canManage ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  onEdit(agent);
                }}
              >
                <EditIcon size={12} /> {t('marketplace.detail.edit')}
              </button>
            ) : null}
          </>
        )}
      </div>

      {budget ? (
        <Section title={t('marketplace.detail.budget')}>
          <div className="mb-2 flex items-center justify-between text-[13px]">
            <span className="mono">
              {t('marketplace.detail.budgetLine', {
                spent: usd(budget.spent_usd),
                limit: usd(budget.limit_usd),
              })}
            </span>
            <span className={`mk-tone-text-${budgetTone(percent)} font-medium`}>{percent}%</span>
          </div>
          <div className="mk-bar-track lg">
            <span
              className={`mk-tone-${budgetTone(percent)}`}
              style={{ width: `${String(Math.min(percent, 100))}%` }}
            />
          </div>
        </Section>
      ) : null}

      <Section title={t('marketplace.detail.model')}>
        <div className="flex flex-wrap gap-1">
          {models.map((model) => (
            <Badge key={model} tone={model === agent.model ? 'accent' : 'neutral'}>
              <ModelName model={model} names={modelNames} />
              {model === agent.model ? t('marketplace.detail.mainModel') : null}
            </Badge>
          ))}
        </div>
      </Section>

      <Section title={t('marketplace.detail.tools', { count: servers.length })}>
        {servers.map(({ server, tools }) => (
          <div key={server} className="mk-line">
            <div className="flex items-center justify-between gap-2">
              <span className="mono text-[12.5px] font-medium">{server}</span>
              {tools.some((name) => unavailable.has(`${server}.${name}`)) ? (
                <Badge tone="amber">{t('marketplace.detail.toolsUnavailable')}</Badge>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {tools.map((name) => (
                <code key={name} className="mc-tool-chip">
                  {name}
                </code>
              ))}
            </div>
          </div>
        ))}
      </Section>

      <Section title={t('marketplace.detail.organization')}>
        <div className="mk-kv">
          <span>{t('marketplace.detail.reportsTo')}</span>
          <span>{supervisor}</span>
        </div>
        {agent.role ? (
          <div className="mk-kv">
            <span>{t('marketplace.detail.role')}</span>
            <span>{agent.role}</span>
          </div>
        ) : null}
      </Section>
      <div className="mk-meta leading-normal">{t('marketplace.detail.shareNote')}</div>
    </SidePanel>
  );
}
