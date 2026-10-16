import { useTranslation } from 'react-i18next';

import type { OperationOutput } from '../../api/operations';
import { CheckIcon, ClockIcon, X2Icon } from '../icons';
import { fmtDate } from './govFormat';
import { Banner, Empty, Spinner } from './govKit';

export type MemberHealth = OperationOutput<'getMemberHealth'>;
type Account = MemberHealth['accounts'][number];

const BADGE: Record<Account['status'], string> = {
  valid: 'badge badge-green',
  invalid: 'badge badge-red',
  pending: 'badge badge-amber',
};
const DOT: Record<Account['status'], string> = { valid: 'green', invalid: 'red', pending: 'amber' };
const ICON = { valid: CheckIcon, invalid: X2Icon, pending: ClockIcon } as const;

interface Props {
  /** The last daily check; `undefined` while it loads, `null` when it could not be read. */
  health: MemberHealth | null | undefined;
}

/**
 * Settings › Conectividad, under "Cuentas miembro": the daily health of the member accounts
 * (D84; design gov/connectivity.jsx `DailyCheck`).
 * The API answers with closed values; every text here is fixed, and the account name (written
 * in AWS Organizations) is rendered as text.
 */
export function MemberHealthSection({ health }: Props) {
  const { t } = useTranslation();
  if (health && health.checked_at !== null && health.accounts.length === 0) {
    // No target accounts: the section does not appear, as in the on-demand check.
    return null;
  }
  let content;
  if (health === undefined) {
    content = (
      <div className="g-card">
        <div className="g-conn-h border-b-0" role="status">
          <Spinner />
          <span>{t('settings.conn.health.loading')}</span>
        </div>
      </div>
    );
  } else if (health === null) {
    content = (
      <Banner tone="error" title={t('settings.conn.health.failed')}>
        {t('settings.conn.health.failedBody')}
      </Banner>
    );
  } else if (health.checked_at === null) {
    content = (
      <div className="g-card">
        <Empty icon={ClockIcon} title={t('settings.conn.health.neverTitle')}>
          {t('settings.conn.health.neverBody')}
        </Empty>
      </div>
    );
  } else {
    const accounts = health.accounts;
    const count = (status: Account['status']) => accounts.filter((a) => a.status === status).length;
    const invalid = count('invalid');
    const pending = count('pending') + Math.max(0, health.total - accounts.length);
    const noIdentity = health.identity_required === false;
    const tone = noIdentity || invalid > 0 ? 'red' : pending > 0 ? 'amber' : 'green';
    const ToneIcon = tone === 'green' ? CheckIcon : tone === 'red' ? X2Icon : ClockIcon;
    content = (
      <div className="g-card">
        <div className="g-conn-h flex-wrap">
          <span className={`g-dot-lg ${tone}`}>
            <ToneIcon size={12} />
          </span>
          <span>
            <b>
              {[
                t('settings.conn.health.valid', { count: count('valid') }),
                t('settings.conn.health.invalid', { count: invalid }),
                t('settings.conn.health.pending', { count: pending }),
              ].join(' · ')}
            </b>
          </span>
          <span className="g-sub ml-auto">
            {t('settings.conn.health.checkedAt', { date: fmtDate(health.checked_at) })}
          </span>
        </div>
        {noIdentity ? (
          <div className="g-check">
            <span className="g-check-i">
              <span className="g-dot-lg sm red">
                <X2Icon size={10} />
              </span>
            </span>
            <div className="min-w-0 flex-1">
              <div className="g-check-n">{t('settings.conn.members.identity.title')}</div>
              <div className="g-check-d bad">{t('settings.conn.health.identityNotRequired')}</div>
            </div>
            <span className="badge badge-red">{t('settings.conn.health.identityBadge')}</span>
          </div>
        ) : null}
        {accounts.map((account) => {
          const Icon = ICON[account.status];
          return (
            <div key={account.account_id} className="g-check">
              <span className="g-check-i">
                <span className={`g-dot-lg sm ${DOT[account.status]}`}>
                  <Icon size={10} />
                </span>
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="g-check-n [overflow-wrap:anywhere]">{account.name}</span>
                  <span className="g-sub mono">{account.account_id}</span>
                </div>
                {account.reason ? (
                  <div className={account.status === 'invalid' ? 'g-check-d bad' : 'g-check-d'}>
                    {t(`settings.conn.health.reasons.${account.reason}`)}
                  </div>
                ) : null}
              </div>
              <span className={BADGE[account.status]}>
                {t(`settings.conn.health.status.${account.status}`)}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="mt-5" role="group" aria-labelledby="conn-health-title">
      <div className="g-sec-h mb-2">
        <div>
          <h3 id="conn-health-title" className="g-sec-t text-[13.5px]">
            {t('settings.conn.health.title')}
          </h3>
          <div className="g-sec-meta">
            {t('settings.conn.health.metaBefore')}
            <span className="mono">mango-health</span>
            {t('settings.conn.health.metaAfter')}
          </div>
        </div>
      </div>
      {content}
    </div>
  );
}
