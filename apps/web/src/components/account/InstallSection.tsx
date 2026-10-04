import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { OperationOutput } from '../../api/operations';
import { useSession } from '../../auth/useSession';
import { Skel } from '../admin/govKit';
import { LockIcon } from '../icons';
import { PersonChip } from '../PersonChip';
import { SettingRow } from './SettingRow';

type Installation = OperationOutput<'getInstallation'>;
type LoadState = { kind: 'loading' } | { kind: 'ready'; data: Installation } | { kind: 'error' };

function ReadOnly({ children, text = false }: { children: ReactNode; text?: boolean }) {
  return (
    <div className={text ? 'ro-field is-text' : 'ro-field'}>
      <LockIcon size={12} />
      {children}
    </div>
  );
}

/**
 * Ajustes › General › Instalación (design settings.jsx `InstallSection`): what was given when
 * Mango was installed, read only. Account ids and mailboxes are for administrators: they come
 * from `GET /api/admin/installation`, which authorizes the call, never from the public
 * `config.json`. Every value is API data, rendered as text. «Publicación» is the label of the
 * release that was installed: it tells two builds of one version apart, and is left out when it
 * says the same as the version.
 */
export function InstallSection() {
  const { t } = useTranslation();
  const { api } = useSession();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.call('getInstallation', {}, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ kind: 'ready', data });
      },
      () => {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, reloadToken]);

  const none = t('people.install.none');
  const data = state.kind === 'ready' ? state.data : null;
  const version = data?.version
    ? t('people.install.versionValue', { version: data.version })
    : null;
  return (
    <div>
      <div className="set-head">
        <h2 className="set-title">{t('people.install.title')}</h2>
        <p className="set-desc">
          {data ? t('people.install.desc') : t('people.install.descShort')}
        </p>
      </div>
      {state.kind === 'error' ? (
        <div className="g-err pp-load-error" role="alert">
          {t('people.install.loadError')}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setState({ kind: 'loading' });
              setReloadToken((value) => value + 1);
            }}
          >
            {t('common.retry')}
          </button>
        </div>
      ) : data === null ? (
        <div className="set-install-skel" role="status" aria-label={t('people.install.loading')}>
          {[0, 1, 2, 3, 4].map((index) => (
            <Skel key={index} w={index % 2 ? '60%' : '80%'} h={18} />
          ))}
        </div>
      ) : (
        <>
          <SettingRow label={t('people.install.version')}>
            <div className="set-row-link">
              <span className="set-version">{version ?? t('people.install.noVersion')}</span>
              {data.release && data.release !== version ? (
                <span className="mk-meta">
                  {t('people.install.release')} <span className="mono">{data.release}</span>
                </span>
              ) : null}
            </div>
          </SettingRow>
          <SettingRow label={t('people.install.update')} hint={t('people.install.updateHint')}>
            <div className="set-row-text">{t('people.install.updateBody')}</div>
          </SettingRow>
          <SettingRow label={t('people.install.name')}>
            <ReadOnly>{data.name}</ReadOnly>
          </SettingRow>
          <SettingRow label={t('people.install.organization')}>
            <ReadOnly>{data.organization_id ?? none}</ReadOnly>
          </SettingRow>
          <SettingRow label={t('people.install.management')}>
            <ReadOnly>{data.management_account_id ?? none}</ReadOnly>
          </SettingRow>
          <SettingRow label={t('people.install.alerts')}>
            <ReadOnly text>{data.alerts_emails.join(', ') || none}</ReadOnly>
          </SettingRow>
          <SettingRow label={t('people.install.domains')}>
            <ReadOnly text>{data.sign_up_domains.join(', ') || none}</ReadOnly>
          </SettingRow>
          <SettingRow
            label={t('people.install.firstAdmins')}
            hint={data.first_admins.length === 1 ? t('people.install.firstAdminsOne') : undefined}
          >
            {data.first_admins.length > 0 ? (
              <ul className="person-chips">
                {data.first_admins.map((email) => (
                  <li key={email}>
                    <PersonChip email={email} />
                  </li>
                ))}
              </ul>
            ) : (
              <ReadOnly text>{none}</ReadOnly>
            )}
          </SettingRow>
          <SettingRow label={t('people.install.inApp')}>
            <div className="set-row-text">
              {t('people.install.inAppBody.lead')}
              <Link className="mk-link" to="/budgets">
                {t('people.install.inAppBody.budgets')}
              </Link>
              {t('people.install.inAppBody.tail')}
            </div>
          </SettingRow>
        </>
      )}
    </div>
  );
}
