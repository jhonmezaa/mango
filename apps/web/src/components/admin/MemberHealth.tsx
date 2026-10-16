import { useTranslation } from 'react-i18next';

import type { OperationOutput } from '../../api/operations';
import { CheckIcon, CloudIcon, X2Icon } from '../icons';
import { fmtDate } from './govFormat';
import { Banner, Empty, Spinner } from './govKit';

export type MemberHealth = OperationOutput<'getMemberHealth'>;
type Account = MemberHealth['accounts'][number];

const BADGE: Record<Account['status'], string> = {
  valid: 'badge badge-green',
  invalid: 'badge badge-red',
  pending: 'badge badge-amber',
};

interface Props {
  /** The last daily check; `undefined` while it loads, `null` when it could not be read. */
  health: MemberHealth | null | undefined;
}

/**
 * Settings › Conectividad › "Cuentas miembro": the daily health of the member accounts (D84).
 * The design has no screen for it yet: this uses only the components of the on-demand check
 * (`.g-card`, `.g-conn-h`, `.g-check`, badges) and is noted for the next design brief (D24).
 * The API answers with closed values; every text here is fixed, and the account name (written
 * in AWS Organizations) is rendered as text.
 */
export function MemberHealthSection({ health }: Props) {
  const { t } = useTranslation();
  if (health === undefined) {
    return (
      <div className="mt-4 g-card">
        <div className="g-conn-h">
          <Spinner />
          <span>{t('settings.conn.health.loading')}</span>
        </div>
      </div>
    );
  }
  if (health !== null && health.checked_at !== null && health.accounts.length === 0) {
    // No target accounts: the section does not appear, as in the on-demand check.
    return null;
  }
  const accounts = health?.accounts ?? [];
  const count = (status: Account['status']) => accounts.filter((a) => a.status === status).length;
  const invalid = count('invalid');
  const pending = count('pending') + Math.max(0, (health?.total ?? 0) - accounts.length);
  const identity = health?.identity_required !== false;
  const ok = invalid === 0 && identity;

  return (
    <div className="mt-4" role="group" aria-labelledby="conn-health-title">
      <div className="g-sec-h mb-2">
        <div>
          <h3 id="conn-health-title" className="g-sec-t text-[13.5px]">
            {t('settings.conn.health.title')}
          </h3>
          <div className="g-sec-meta">{t('settings.conn.health.meta')}</div>
        </div>
      </div>
      {health === null ? (
        <Banner tone="error" title={t('settings.conn.health.failed')}>
          {t('settings.conn.health.failedBody')}
        </Banner>
      ) : health.checked_at === null ? (
        <div className="g-card">
          <Empty icon={CloudIcon} title={t('settings.conn.health.neverTitle')}>
            {t('settings.conn.health.neverBody')}
          </Empty>
        </div>
      ) : (
        <div className="g-card">
          <div className="g-conn-h">
            <span className={ok ? 'g-dot-lg green' : 'g-dot-lg red'}>
              {ok ? <CheckIcon size={12} /> : <X2Icon size={12} />}
            </span>
            <span>
              <b>
                {t('settings.conn.health.summary', {
                  valid: count('valid'),
                  invalid,
                  pending,
                })}
              </b>
            </span>
            <span className="g-sub ml-auto">{fmtDate(health.checked_at)}</span>
          </div>
          {identity ? null : (
            <div className="g-check">
              <div className="min-w-0 flex-1">
                <div className="g-check-n">{t('settings.conn.members.identity.title')}</div>
                <div className="g-check-d bad">
                  {t('settings.conn.members.identity.notRequired')}
                </div>
                <div className="g-help">
                  <b>{t('settings.conn.whatToCheck')}</b> {t('settings.conn.members.identity.help')}
                </div>
              </div>
              <span className="badge badge-red">{t('settings.conn.error')}</span>
            </div>
          )}
          {accounts.map((account) => (
            <div key={account.account_id} className="g-check">
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
          ))}
        </div>
      )}
    </div>
  );
}
