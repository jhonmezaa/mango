import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { WarnIcon } from '../../components/icons';
import { SidePanel } from '../../components/SidePanel';
import { budgetPercent } from '../../lib/format';
import {
  coversMonth,
  coversPrevious,
  formatCount,
  money,
  num,
  type AgentCost,
  type Costs,
} from './model';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mk-sec">
      <h3 className="mk-sec-t">{title}</h3>
      {children}
    </section>
  );
}

interface Props {
  row: AgentCost;
  name: string;
  sub: string;
  data: Costs;
  /** Administrators also get «Ver presupuestos» and «Ver trazas» (D105: the rest is the same). */
  admin: boolean;
  onClose: () => void;
}

/**
 * An agent's costs this month (design round 37 `CostAgent`): the month, the one before and the
 * projection, its budget (only in the current month: past limits are not kept) and its real
 * queries. No «Por origen»: the product counts the origin of the organization only (round 38).
 */
export function CostAgent({ row, name, sub, data, admin, onClose }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const since = data.agents.counted_since;
  const spent = num(row.spent_usd);
  const whole = coversMonth(since, data);
  const projected = whole && row.projected_usd !== null ? num(row.projected_usd) : null;
  const budget = row.budget;
  const go = (path: string) => {
    onClose();
    void navigate(path);
  };
  return (
    <SidePanel
      title={name}
      meta={<span className="mk-meta">{sub}</span>}
      width={460}
      onClose={onClose}
    >
      <div className="ob-sum co-sum3">
        <div>
          <span>{t('costs.drawer.thisMonth')}</span>
          <b className="mono">{money(spent)}</b>
        </div>
        <div>
          <span>{t('costs.drawer.previous')}</span>
          <b className="mono">{coversPrevious(since, data) ? money(num(row.previous_usd)) : '—'}</b>
        </div>
        <div>
          <span>{t('costs.drawer.projection')}</span>
          <b className="mono">{projected === null ? '—' : money(projected)}</b>
        </div>
      </div>
      {budget && (
        <Section title={t('costs.drawer.budget')}>
          <div className="mk-kv">
            <span>{t('costs.drawer.limit')}</span>
            <span className="mono">{money(num(budget.limit_usd))}</span>
          </div>
          <div className="mk-kv">
            <span>{t('costs.drawer.used')}</span>
            <span className="mono">{budgetPercent(budget.spent_usd, budget.limit_usd)}%</span>
          </div>
          {projected !== null && projected > num(budget.limit_usd) && (
            <div className="mc-alert amber co-alert">
              <WarnIcon size={13} />
              <div>{t('costs.drawer.overPace')}</div>
            </div>
          )}
        </Section>
      )}
      <Section title={t('costs.drawer.queries')}>
        <div className="mk-kv">
          <span>{t('costs.drawer.perQuery')}</span>
          <span className="mono">{money(spent / Math.max(1, row.turns))}</span>
        </div>
        <div className="mk-kv">
          <span>{t('costs.drawer.queryCount')}</span>
          <span className="mono">{formatCount(row.turns)}</span>
        </div>
      </Section>
      {admin && (
        <div className="co-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              go('/budgets');
            }}
          >
            {t('costs.drawer.toBudgets')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              go('/observability');
            }}
          >
            {t('costs.drawer.toTraces')}
          </button>
        </div>
      )}
      {admin && budget && <div className="mk-meta">{t('costs.drawer.limitNote')}</div>}
    </SidePanel>
  );
}
