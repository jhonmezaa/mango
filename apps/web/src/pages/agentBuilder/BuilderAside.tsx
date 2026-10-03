import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { CheckIcon, ShieldIcon } from '../../components/icons';
import { formatUsd } from '../../lib/format';
import { AgentIcon } from './AgentIcon';
import { agentColor } from './agentIcons';
import type { Quotas, SectionId } from './model';

const CHECKS = ['identity', 'brain', 'tools', 'access'] as const;

interface Props {
  name: string;
  description: string;
  category: string;
  icon: string;
  color: number;
  /** Display name of the default model. */
  modelName: string;
  toolCount: number;
  writeCount: number;
  /** Monthly limit in USD; null when the caller cannot see budgets. */
  budgetUsd: string | null;
  /** Sections with something to fix before sending. */
  pending: ReadonlySet<SectionId>;
  ready: boolean;
  quotas: Quotas;
  onGo: (section: SectionId) => void;
}

/** Right column (design `ab-aside`): marketplace preview, checklist and the creator's quotas. */
export const BuilderAside = memo(function BuilderAside({
  name,
  description,
  category,
  icon,
  color,
  modelName,
  toolCount,
  writeCount,
  budgetUsd,
  pending,
  ready,
  quotas,
  onGo,
}: Props) {
  const { t } = useTranslation();
  const tone = agentColor(color);
  const overDaily = quotas.submissions_today >= quotas.max_submissions_per_day;
  return (
    <aside className="ab-aside">
      <div className="ab-aside-label">{t('agentBuilder.aside.preview')}</div>
      <div className="card ab-preview">
        <div className="ab-preview-head">
          <span className="ab-preview-icon" style={{ background: tone.bg, color: tone.color }}>
            <AgentIcon name={icon} size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className={name ? 'ab-preview-name' : 'ab-preview-name is-empty'}>
              {name || t('agentBuilder.aside.noName')}
            </div>
            <div className="ab-preview-meta">
              {category} · {modelName}
            </div>
          </div>
        </div>
        <div className={description ? 'ab-preview-desc' : 'ab-preview-desc is-empty'}>
          {description || t('agentBuilder.aside.noDescription')}
        </div>
        <div className="ab-preview-foot">
          <span>
            {t('agentBuilder.aside.tools', { count: toolCount })}
            {writeCount > 0 && t('agentBuilder.aside.writeTools', { count: writeCount })}
          </span>
          {budgetUsd !== null && <span className="mono">{formatUsd(budgetUsd)}</span>}
        </div>
      </div>

      <div className="ab-aside-label is-next">
        {ready ? t('agentBuilder.aside.ready') : t('agentBuilder.aside.beforeSending')}
      </div>
      <div className="ab-checks">
        {CHECKS.map((section) => {
          const ok = !pending.has(section);
          return (
            <button
              key={section}
              type="button"
              className={ok ? 'is-ok' : undefined}
              onClick={() => {
                onGo(section);
              }}
            >
              <span className="ab-step">{ok && <CheckIcon size={10} />}</span>
              {t(`agentBuilder.aside.checks.${section}`)}
            </button>
          );
        })}
      </div>

      <div className="ab-aside-label is-next">{t('agentBuilder.aside.quotas')}</div>
      <div className="ab-quota">
        <span>{t('agentBuilder.aside.drafts')}</span>
        <span className="mono">
          {quotas.drafts} / {quotas.max_drafts}
        </span>
      </div>
      <div className="ab-quota">
        <span>{t('agentBuilder.aside.submissionsToday')}</span>
        <span className={overDaily ? 'mono is-over' : 'mono'}>
          {quotas.submissions_today} / {quotas.max_submissions_per_day}
        </span>
      </div>
      <div className="ab-approval">
        <ShieldIcon size={13} />
        {t('agentBuilder.aside.approvalNote')}
      </div>
    </aside>
  );
});
