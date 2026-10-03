import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { OperationOutput } from '../../api/operations';
import { CheckIcon, X2Icon } from '../icons';
import { Banner } from './govKit';

export type MemberAccess = OperationOutput<'memberAccessCheck'>;

interface Props {
  /** The last check, or null when it could not run (the connection above is in order). */
  access: MemberAccess | null;
}

function Mark({ ok, small = false }: { ok: boolean; small?: boolean }) {
  const size = small ? 10 : 12;
  const tone = ok ? 'green' : 'red';
  return (
    <span className={small ? `g-dot-lg ${tone} sm` : `g-dot-lg ${tone}`}>
      {ok ? <CheckIcon size={size} /> : <X2Icon size={size} />}
    </span>
  );
}

/** One row of the card (design `.g-check`): a mark, its texts and the ok/error badge. */
function CheckRow({ ok, children }: { ok: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="g-check">
      <span className="g-check-i">
        <Mark ok={ok} small />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      <span className={ok ? 'badge badge-green' : 'badge badge-red'}>
        {ok ? t('settings.conn.ok') : t('settings.conn.error')}
      </span>
    </div>
  );
}

/**
 * Settings › Conectividad › "Cuentas miembro" (design gov/connectivity.jsx `MemberAccounts`).
 * Whether the broker demands the identity of the user is one row: it is checked on the broker
 * role, so the answer stands for every account. Each account then only says whether its read
 * role exists. When the check itself fails the section keeps its heading and shows its own
 * banner (the connection above is in order), and with more target accounts than the check covers
 * it says how many were left out. The API answers with closed values; every text here is fixed,
 * and the account name (written in AWS Organizations) is rendered as text.
 */
export function MemberAccounts({ access }: Props) {
  const { t } = useTranslation();
  const accounts = access?.accounts ?? [];
  const checked = accounts.length;
  const missing = accounts.filter((account) => account.status === 'role_missing').length;
  // Null only without accounts; an account-level answer covers an API that predates the field.
  const identity =
    access?.identity_required ??
    !accounts.some((account) => account.status === 'identity_not_required');
  const ok = identity && missing === 0;
  const total = access?.total ?? checked;

  return (
    <div className="mt-4" role="group" aria-labelledby="conn-members-title">
      <div className="g-sec-h mb-2">
        <div>
          <h3 id="conn-members-title" className="g-sec-t text-[13.5px]">
            {t('settings.conn.members.title')}
          </h3>
          <div className="g-sec-meta">{t('settings.conn.members.meta')}</div>
        </div>
      </div>
      {access === null ? (
        <Banner tone="error" title={t('settings.conn.members.failed')}>
          {t('settings.conn.members.failedBody')}
        </Banner>
      ) : (
        <>
          {total > checked ? (
            <div className="mb-2.5">
              <Banner tone="warn" title={t('settings.conn.members.partial', { checked, total })}>
                {t('settings.conn.members.partialBody', {
                  max: checked,
                  count: total - checked,
                })}
              </Banner>
            </div>
          ) : null}
          <div className="g-card">
            <div className="g-conn-h">
              <Mark ok={ok} />
              <span>
                <b>
                  {ok
                    ? t('settings.conn.members.allOk', { count: checked })
                    : identity
                      ? t('settings.conn.members.someFailed', { failed: missing, total: checked })
                      : t('settings.conn.members.noneReadable')}
                </b>
              </span>
            </div>
            <CheckRow ok={identity}>
              <div className="g-check-n">{t('settings.conn.members.identity.title')}</div>
              <div className={identity ? 'g-check-d' : 'g-check-d bad'}>
                {t('settings.conn.members.identity.body')}{' '}
                {identity
                  ? t('settings.conn.members.identity.required')
                  : t('settings.conn.members.identity.notRequired')}
              </div>
              {identity ? null : (
                <div className="g-help">
                  <b>{t('settings.conn.whatToCheck')}</b> {t('settings.conn.members.identity.help')}
                </div>
              )}
            </CheckRow>
            {accounts.map((account) => {
              const role = account.status !== 'role_missing';
              return (
                <CheckRow key={account.account_id} ok={role}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="g-check-n [overflow-wrap:anywhere]">{account.name}</span>
                    <span className="g-sub mono">{account.account_id}</span>
                  </div>
                  <div className={role ? 'g-check-d' : 'g-check-d bad'}>
                    {role
                      ? t('settings.conn.members.role.exists')
                      : t('settings.conn.members.role.missing')}
                  </div>
                  {role ? null : (
                    <div className="g-help">
                      <b>{t('settings.conn.whatToCheck')}</b> {t('settings.conn.members.role.help')}
                    </div>
                  )}
                </CheckRow>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
