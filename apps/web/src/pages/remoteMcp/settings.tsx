import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useSession } from '../../auth/useSession';
import { ArrowRightIcon, LockIcon } from '../../components/icons';
import { useToasts } from '../../components/admin/useToasts';
import { formatRelative } from '../../lib/format';
import {
  failInfoOf,
  pendingRows,
  personOf,
  remotePath,
  settingsRows,
  toolsOf,
  type Registration,
  type RemoteProfile,
  type Row,
} from './model';
import { DisableModal, RotateModal } from './modals';
import { RemoteOffNote, RmStatus, RmTile, SecretAlert, SecretLine } from './parts';
import { useRemoteActions, useRemoteCatalog } from './useRemoteCatalog';

/**
 * Design `RemoteConnBlock`: Ajustes › Conectividad › «Servicios externos». The secret's warnings
 * are computed by the API on every read (D98 (7), P-7); rotating and disabling go to the same
 * routes as the catalog, and the API authorizes them.
 */
export function RemoteConnBlock() {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const navigate = useNavigate();
  const { notify, stack } = useToasts();
  const remote = useRemoteCatalog(api);
  const act = useRemoteActions(api, remote.replace, notify);
  const [modal, setModal] = useState<{ k: 'rotate' | 'disable'; key: string } | null>(null);

  if (remote.state.kind === 'loading') return null;
  if (remote.state.kind === 'error') {
    return (
      <div className="mt-7">
        <div className="g-sec-t text-[13.5px]">{t('remoteMcp.settings.title')}</div>
        <div className="mk-meta mt-2">{t('remoteMcp.settings.loadError')}</div>
      </div>
    );
  }
  const catalog = remote.state.data;
  const list = settingsRows(catalog);
  const pending = pendingRows(catalog);
  const open = (row: Row) => {
    void navigate(remotePath(row.registration.profile_id, row));
  };
  const shown = modal ? list.find((row) => row.key === modal.key) : undefined;
  const shownProfile = shown
    ? catalog.profiles.find((profile) => profile.id === shown.registration.profile_id)
    : undefined;
  const firstPending = pending[0];

  return (
    <div className="mt-7">
      <div className="g-sec-h mb-2">
        <div>
          <h3 className="g-sec-t text-[13.5px]">{t('remoteMcp.settings.title')}</h3>
          <div className="g-sec-meta">{t('remoteMcp.settings.meta')}</div>
        </div>
        {firstPending ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              open(firstPending);
            }}
          >
            {t('remoteMcp.settings.pending', { count: pending.length })}{' '}
            <ArrowRightIcon size={11} />
          </button>
        ) : null}
      </div>
      {catalog.enabled ? null : (
        <div className="mb-2.5">
          <RemoteOffNote />
        </div>
      )}
      {list.length === 0 ? (
        <div className="g-card p-4">
          <div className="mk-meta">
            {t('remoteMcp.settings.emptyA')}
            <button
              type="button"
              className="sr-link"
              onClick={() => {
                void navigate(remotePath());
              }}
            >
              {t('remoteMcp.settings.emptyLink')}
            </button>
            {t('remoteMcp.settings.emptyB')}
          </div>
        </div>
      ) : (
        <div className="grid gap-2.5">
          {list.map((row) => {
            const profile = catalog.profiles.find(
              (item) => item.id === row.registration.profile_id,
            );
            if (!profile) return null;
            const reg = row.registration;
            const live = reg.status === 'active';
            return (
              <div key={row.key} className="g-card rm-setrow">
                <div className="flex items-start gap-3">
                  <RmTile profile={profile} />
                  <div className="grid min-w-0 flex-1 gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mk-name">{profile.name}</span>
                      <span className="mono mk-meta">
                        {profile.host}/{reg.organization}
                      </span>
                      <RmStatus status={row.status} />
                    </div>
                    <div className="rm-sets">
                      {toolsOf(profile, reg.toolsets).map((toolset) => (
                        <span key={toolset.id} className="rm-set">
                          {toolset.label}
                        </span>
                      ))}
                    </div>
                    <div className="mk-meta">
                      {t('remoteMcp.settings.groups')}{' '}
                      <span className="mono">{reg.groups.join(', ')}</span>
                    </div>
                    {live ? (
                      <div className="flex items-center gap-2 text-[12.5px]">
                        <LockIcon size={11} />
                        <span className="mk-meta">{t('remoteMcp.settings.secret')}</span>
                        <SecretLine registration={reg} />
                      </div>
                    ) : null}
                    {row.status === 'disabled' ? (
                      <div className="mk-meta">
                        {t('remoteMcp.settings.disabledBy', {
                          by:
                            personOf(reg.disabled_by, null, me.user_id) === 'me'
                              ? t('remoteMcp.row.you')
                              : (reg.disabled_by ?? ''),
                          when: reg.disabled_at ? formatRelative(reg.disabled_at) : '',
                        })}
                      </div>
                    ) : null}
                    {row.status === 'creating' ? (
                      <div className="mk-meta flex items-center gap-2">
                        <span className="g-spin" aria-hidden="true" />{' '}
                        {t('remoteMcp.settings.creating')}
                      </div>
                    ) : null}
                    {row.status === 'failed' ? (
                      <FailLine registration={reg} profile={profile} />
                    ) : null}
                  </div>
                </div>
                {live ? <SecretAlert registration={reg} profile={profile} /> : null}
                <div className="flex flex-wrap items-center gap-2">
                  {live ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setModal({ k: 'rotate', key: row.key });
                        }}
                      >
                        {t('remoteMcp.settings.rotate')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setModal({ k: 'disable', key: row.key });
                        }}
                      >
                        {t('remoteMcp.settings.disable')}
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      open(row);
                    }}
                  >
                    {t('remoteMcp.settings.open')} <ArrowRightIcon size={11} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {modal && shown && shownProfile ? (
        modal.k === 'rotate' ? (
          <RotateModal
            registration={shown.registration}
            profile={shownProfile}
            onAct={act}
            onClose={() => {
              setModal(null);
            }}
          />
        ) : (
          <DisableModal
            registration={shown.registration}
            profile={shownProfile}
            onAct={act}
            onClose={() => {
              setModal(null);
            }}
          />
        )
      ) : null}
      {stack}
    </div>
  );
}

/** Design `RemoteConnBlock`, a failed registration: the title by its code and where to fix it. */
function FailLine({
  registration,
  profile,
}: {
  registration: Pick<Registration, 'failure_code'>;
  profile: Pick<RemoteProfile, 'name' | 'provider'>;
}) {
  const { t } = useTranslation();
  const info = failInfoOf(registration);
  return (
    <div className="text-[12.5px]">
      <span className="text-[var(--red)]">
        {t(`remoteMcp.row.fail.${info.title}` as 'remoteMcp.row.fail.unknown', {
          name: profile.name,
          idp: profile.provider,
        })}
        .
      </span>{' '}
      <span className="mk-meta">{t(`remoteMcp.settings.failHint.${info.kind}`)}</span>
    </div>
  );
}
