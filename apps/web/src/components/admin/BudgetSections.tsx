import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Budgets, UserBudget } from '../../api/adminSchemas';
import { EditIcon, LockIcon, SearchIcon } from '../icons';
import {
  STATUS_BADGE,
  STATUS_COLOR,
  pctOf,
  shortId,
  statusOf,
  toNumber,
  usd,
  type BudgetStatus,
} from './govFormat';

/** Spent/limit bar with the amounts and the percentage (design budget rows). */
export function UsageCell({
  label,
  spent,
  limit,
  status,
}: {
  label: string;
  spent: string;
  limit: string;
  /** The row's state, so the bar and its badge never disagree (default: from the rounded %). */
  status?: BudgetStatus | undefined;
}) {
  const { t } = useTranslation();
  const percent = Math.round(pctOf(toNumber(spent), toNumber(limit)));
  const color = STATUS_COLOR[status ?? statusOf(percent)];
  return (
    <div>
      <div
        className="bg-track"
        role="progressbar"
        aria-valuenow={Math.min(percent, 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t('budgets.usageLabel', { name: label })}
      >
        <span style={{ width: `${String(Math.min(percent, 100))}%`, background: color }} />
      </div>
      <div className="bg-amounts mono">
        <span className="whitespace-nowrap">
          {usd(spent)} / {usd(limit)}
        </span>
        <span style={{ color }}>{percent}%</span>
      </div>
    </div>
  );
}

export function StatusPill({
  status,
  label,
}: {
  status: BudgetStatus;
  label?: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <span className={`badge ${STATUS_BADGE[status]} justify-self-start`}>
      {label ?? t(`gov.status.${status}`)}
    </span>
  );
}

// --- Valores por defecto (design gov/budgets.jsx `BudgetDefaults`) ---------------------------

export function BudgetDefaults({
  data,
  agentsOnDefault,
  onEdit,
}: {
  data: Budgets;
  agentsOnDefault: number;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const onDefault = data.users.filter((user) => !user.override).length;
  const perMonth = <span className="text-muted"> {t('budgets.defaults.perMonth')}</span>;
  return (
    <section className="mb-7" aria-labelledby="budgets-defaults">
      <div className="mb-2.5 flex items-center justify-between">
        <h2 id="budgets-defaults" className="bg-sec-t">
          {t('budgets.defaults.title')}
        </h2>
        <div className="text-[11px] text-muted">{t('budgets.defaults.action')}</div>
      </div>
      <div className="card p-0">
        <div className="bg-row bg-row-3">
          <div className="min-w-0">
            <div className="bg-name">{t('budgets.defaults.user')}</div>
            <div className="bg-sub">{t('budgets.defaults.userSub', { count: onDefault })}</div>
          </div>
          <div className="mono text-[12.5px]">
            {usd(data.defaults.user_monthly_usd)}
            {perMonth}
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label={t('budgets.defaults.edit')}
            title={t('budgets.editTitle')}
            onClick={onEdit}
          >
            <EditIcon size={12} />
          </button>
        </div>
        <div className="bg-row bg-row-3 border-t border-border">
          <div className="min-w-0">
            <div className="bg-name">{t('budgets.defaults.agent')}</div>
            <div className="bg-sub">
              {t('budgets.defaults.agentSub')}
              {agentsOnDefault > 0 &&
                ` · ${t('budgets.defaults.agentsUsing', { count: agentsOnDefault })}`}
            </div>
          </div>
          <div className="mono text-[12.5px]">
            {usd(data.defaults.agent_monthly_usd)}
            {perMonth}
          </div>
          <span />
        </div>
      </div>
    </section>
  );
}

// --- Por usuario (design gov/budgets.jsx `UserBudgets`) --------------------------------------

type UserFilter = 'all' | 'warn' | 'out' | 'own';

interface UserRow extends UserBudget {
  percent: number;
  status: BudgetStatus;
  isMe: boolean;
}

export function UserBudgets({
  data,
  meId,
  onEdit,
}: {
  data: Budgets;
  meId: string;
  onEdit: (user: UserBudget) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<UserFilter>('all');
  const users: UserRow[] = data.users.map((user) => {
    const percent = pctOf(toNumber(user.spent_usd), toNumber(user.limit_usd));
    return { ...user, percent, status: statusOf(percent), isMe: user.user_id === meId };
  });
  const needle = query.trim().toLowerCase();
  const list = users
    .filter((user) =>
      filter === 'all' ? true : filter === 'own' ? user.override : user.status === filter,
    )
    .filter(
      (user) =>
        !needle ||
        (user.email ?? '').toLowerCase().includes(needle) ||
        user.user_id.toLowerCase().includes(needle),
    )
    .sort((a, b) => Number(b.isMe) - Number(a.isMe) || b.percent - a.percent);
  const count = (predicate: (user: UserRow) => boolean) => users.filter(predicate).length;

  return (
    <section className="mb-7" aria-labelledby="budgets-users">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-3">
        <h2 id="budgets-users" className="bg-sec-t">
          {t('budgets.users.title')}
        </h2>
        <div className="flex items-center gap-2">
          <div className="search-wrap w-[200px]">
            <SearchIcon size={12} />
            <input
              className="input bg-input-sm"
              placeholder={t('budgets.users.search')}
              aria-label={t('budgets.users.searchLabel')}
              maxLength={200}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
          <select
            className="input bg-select-sm"
            aria-label={t('budgets.users.filterLabel')}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as UserFilter);
            }}
          >
            <option value="all">{t('budgets.users.all', { count: users.length })}</option>
            <option value="warn">
              {t('budgets.users.warn', { count: count((user) => user.status === 'warn') })}
            </option>
            <option value="out">
              {t('budgets.users.out', { count: count((user) => user.status === 'out') })}
            </option>
            <option value="own">
              {t('budgets.users.own', { count: count((user) => user.override) })}
            </option>
          </select>
        </div>
      </div>
      <div className="card p-0">
        {list.length === 0 && (
          <div className="px-4 py-[18px] text-[12.5px] text-muted">
            {users.length ? t('budgets.users.noMatch') : t('budgets.users.empty')}
          </div>
        )}
        <ul className="m-0 list-none p-0">
          {list.map((user, index) => {
            const label = user.email ?? shortId(user.user_id);
            const sub = [
              user.email ? '' : `${t('budgets.users.noEmail')} · `,
              user.override ? t('budgets.users.ownLimit') : t('budgets.users.byDefault'),
              user.isMe ? ` · ${t('budgets.users.readOnly')}` : '',
            ].join('');
            return (
              <li key={user.user_id} className={index ? 'bg-row border-t border-border' : 'bg-row'}>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={user.email ? 'bg-name' : 'bg-name mono'} title={label}>
                      {label}
                    </span>
                    {user.isMe && (
                      <span className="badge badge-accent shrink-0">{t('budgets.users.you')}</span>
                    )}
                  </div>
                  <div
                    className="bg-sub"
                    title={user.isMe ? t('budgets.users.selfHint') : undefined}
                  >
                    {sub}
                  </div>
                </div>
                <UsageCell
                  label={label}
                  spent={user.spent_usd}
                  limit={user.limit_usd}
                  status={user.status}
                />
                <StatusPill status={user.status} />
                {user.isMe ? (
                  // TM-A3: nobody edits their own budget; the API answers 403 self_edit anyway.
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled
                    aria-label={t('budgets.users.selfLabel')}
                    title={t('budgets.users.selfHint')}
                  >
                    <LockIcon size={12} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    aria-label={t('budgets.editLabel', { name: label })}
                    title={t('budgets.editTitle')}
                    onClick={() => {
                      onEdit(user);
                    }}
                  >
                    <EditIcon size={12} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

// --- Por agente / Por equipo (design audit-budgets.jsx `Section`) -----------------------------

export interface BudgetLine {
  id: string;
  name: string;
  sub: string;
  /** Tooltip of `sub`: what happens at 100 % (design `BUDGET_ACTION_DESC`). */
  subTitle?: string | undefined;
  spent: string;
  limit: string;
  action: ReactNode;
}

export function BudgetSection({
  title,
  lines,
  labelledBy,
}: {
  title: string;
  lines: readonly BudgetLine[];
  labelledBy: string;
}) {
  const { t } = useTranslation();
  const limit = lines.reduce((sum, line) => sum + toNumber(line.limit), 0);
  const spent = lines.reduce((sum, line) => sum + toNumber(line.spent), 0);
  return (
    <section className="mb-7" aria-labelledby={labelledBy}>
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 id={labelledBy} className="bg-sec-t">
          {title} <span className="text-dim">· {lines.length}</span>
        </h2>
        {lines.length > 0 && (
          <div className="mono text-[11px] text-muted">
            {t('budgets.sectionTotal', { spent: usd(spent), limit: usd(limit) })}
          </div>
        )}
      </div>
      <div className="card p-0">
        {lines.length === 0 && (
          <div className="p-4 text-[12.5px] text-muted">{t('budgets.sectionEmpty')}</div>
        )}
        <ul className="m-0 list-none p-0">
          {lines.map((line, index) => {
            const percent = Math.round(pctOf(toNumber(line.spent), toNumber(line.limit)));
            const status = statusOf(percent);
            return (
              <li key={line.id} className={index ? 'bg-row border-t border-border' : 'bg-row'}>
                <div className="min-w-0">
                  <div className="bg-name">{line.name}</div>
                  <div className="bg-sub" title={line.subTitle}>
                    {line.sub}
                  </div>
                </div>
                <UsageCell label={line.name} spent={line.spent} limit={line.limit} />
                <StatusPill
                  status={status}
                  label={status === 'out' ? t('budgets.exceeded') : undefined}
                />
                {line.action}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
