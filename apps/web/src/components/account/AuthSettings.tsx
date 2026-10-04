import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../auth/useSession';
import { safeHttpsHref } from '../../security/safeUrl';
import { LockIcon } from '../icons';
import { Soon } from '../Soon';
import { SettingRow } from './SettingRow';

function ReadOnly({ children, text = false }: { children: ReactNode; text?: boolean }) {
  return (
    <div className={text ? 'ro-field is-text' : 'ro-field'}>
      <LockIcon size={12} />
      {children}
    </div>
  );
}

const PROPOSABLE = ['mfa', 'session', 'idp'] as const;

/**
 * Ajustes › General › Autenticación (design settings.jsx `AuthSection`/`ProposedRow`).
 * Everything comes from the installation (`config.json`) and is read-only: MFA, session and IdP
 * show their current value. "Proponer cambio" is "Próximamente": D21 has no backend yet, so there
 * are no sample proposals (D24). An MFA reset is asked for on the person, in Ajustes › Personas.
 */
export function AuthSettings({ onGoPeople }: { onGoPeople: () => void }) {
  const { t } = useTranslation();
  const { config } = useSession();
  const policyHref = safeHttpsHref(config.aiPolicyUrl);
  const { auth } = config;
  const current: Record<(typeof PROPOSABLE)[number], string> = {
    mfa: t(`settings.auth.values.mfa.${auth.mfa}`),
    session: t('settings.auth.values.sessionHours', { count: auth.sessionHours }),
    idp: config.ssoProvider ?? t('settings.auth.values.idpNone'),
  };

  return (
    <div>
      <div className="set-head">
        <h2 className="set-title">{t('settings.auth.title')}</h2>
        <p className="set-desc">{t('settings.auth.desc')}</p>
      </div>
      <div className="card set-card">
        <SettingRow label={t('settings.auth.userPool')}>
          <ReadOnly>{config.userPoolId}</ReadOnly>
        </SettingRow>
        <SettingRow label={t('settings.auth.region')}>
          <ReadOnly>{config.region}</ReadOnly>
        </SettingRow>
        <SettingRow label={t('settings.auth.clientId')} hint={t('settings.auth.readOnlyInstall')}>
          <ReadOnly>{config.clientId}</ReadOnly>
        </SettingRow>
      </div>
      {PROPOSABLE.map((key) => {
        const setting = t(`settings.auth.${key}`);
        // Customer installations always require MFA (installation schema): shown as fixed. A lab
        // one may have it off, so «siempre obligatorio» is only said where it is true.
        const fixedMfa = key === 'mfa' && auth.installationType === 'customer';
        return (
          <SettingRow
            key={key}
            label={setting}
            hint={fixedMfa ? t('settings.auth.mfaFixedHint') : undefined}
          >
            <div className="set-row-actions">
              <span className="set-row-current">{current[key]}</span>
              <div className="flex-1" />
              {fixedMfa ? (
                <ReadOnly text>{t('settings.auth.mfaFixed')}</ReadOnly>
              ) : (
                <Soon name={t('settings.auth.proposeSoon', { setting })}>
                  <button type="button" className="btn btn-sm" tabIndex={-1}>
                    {t('settings.auth.propose')}
                  </button>
                </Soon>
              )}
            </div>
          </SettingRow>
        );
      })}
      <SettingRow label={t('settings.auth.domains')} hint={t('settings.auth.domainsHint')}>
        <ReadOnly text>{config.signUpDomains.join(', ')}</ReadOnly>
      </SettingRow>
      <SettingRow label={t('settings.auth.aiPolicy')} hint={t('settings.auth.aiPolicyHint')}>
        {policyHref ? (
          <a className="ro-field" href={policyHref} target="_blank" rel="noopener noreferrer">
            <LockIcon size={12} />
            {policyHref}
          </a>
        ) : (
          <ReadOnly>{t('settings.auth.aiPolicyNone')}</ReadOnly>
        )}
      </SettingRow>
      <SettingRow
        label={t('settings.auth.passwordPolicy')}
        hint={t('settings.auth.passwordPolicyHint')}
      >
        <ReadOnly>{t('auth.validation.password')}</ReadOnly>
      </SettingRow>
      <SettingRow label={t('settings.auth.perUser')} hint={t('settings.auth.perUserHint')}>
        <div className="set-row-text">{t('settings.auth.perUserBody')}</div>
      </SettingRow>
      <SettingRow label={t('settings.auth.mfaReset')} hint={t('settings.auth.mfaResetHint')}>
        <div className="set-row-link">
          <span className="set-row-text">{t('settings.auth.mfaResetBody')}</span>
          <button type="button" className="sr-link" onClick={onGoPeople}>
            {t('settings.auth.goPeople')}
          </button>
        </div>
      </SettingRow>
    </div>
  );
}
