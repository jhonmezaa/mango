import { useTranslation } from 'react-i18next';

import { ArrowRightIcon } from '../../components/icons';
import { formatRelative } from '../../lib/format';
import { headlineOf, pendingRows, personOf, rowsOf, type RemoteCatalog, type Row } from './model';
import { RemoteOffNote, RmBadges, RmStatus, RmTile } from './parts';

/** Design `RemoteCatalogTab`: one card per profile of the release. */
export function RemoteCatalogTab({
  catalog,
  onOpen,
}: {
  catalog: RemoteCatalog;
  onOpen: (profileId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3.5">
      {catalog.enabled ? null : <RemoteOffNote />}
      <p className="rm-p m-0 max-w-[720px]">{t('remoteMcp.intro')}</p>
      <div className="rm-grid">
        {catalog.profiles.map((profile) => {
          const rows = rowsOf(catalog, profile.id);
          const head = headlineOf(rows);
          const reg = head?.registration;
          const facts = head?.request ?? reg;
          let foot;
          if (!head || !reg || !facts) foot = t('remoteMcp.card.none');
          else if (head.status === 'active' || head.status === 'secretExpired') {
            foot = (
              <>
                {t('remoteMcp.card.enabledFor')} <span className="mono">{reg.organization}</span> ·{' '}
                {t('remoteMcp.card.groups', { count: reg.groups.length })}
              </>
            );
          } else if (head.status === 'creating' || head.status === 'failed') {
            foot = (
              <>
                {head.status === 'creating'
                  ? t('remoteMcp.card.creating')
                  : t('remoteMcp.card.failed')}{' '}
                · <span className="mono">{reg.organization}</span>
              </>
            );
          } else if (head.status === 'pending') {
            foot = (
              <>
                {t('remoteMcp.card.pending')} · <span className="mono">{reg.organization}</span>
              </>
            );
          } else {
            foot = (
              <>
                {t('remoteMcp.card.disabledFor')} <span className="mono">{reg.organization}</span>
              </>
            );
          }
          return (
            <button
              key={profile.id}
              type="button"
              className="card rm-pcard"
              onClick={() => {
                onOpen(profile.id);
              }}
            >
              <div className="flex items-start gap-3">
                <RmTile profile={profile} />
                <div className="min-w-0 flex-1">
                  <div className="mk-name">{profile.name}</div>
                  <div className="mk-meta">
                    {t('remoteMcp.operatedBy', { operator: profile.operator })} ·{' '}
                    <span className="mono">{profile.host}</span>
                  </div>
                </div>
                {profile.enabled_in_installation ? (
                  <RmStatus status={head?.status ?? null} />
                ) : (
                  <span className="badge">{t('remoteMcp.off.badge')}</span>
                )}
              </div>
              <RmBadges profile={profile} compact />
              <div className="rm-sets">
                {profile.toolsets.map((toolset) => (
                  <span key={toolset.id} className="rm-set">
                    {toolset.label}
                  </span>
                ))}
              </div>
              <div className="mk-meta rm-pcard-f">
                <span>{foot}</span>
                <span className="ml-auto flex items-center gap-1">
                  {t('remoteMcp.seeCard')} <ArrowRightIcon size={11} />
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Design `RemoteRequests`: the requests waiting for a decision, above the packs ones in
 * «Solicitudes pendientes». Only administrators get requests from the API.
 */
export function RemoteRequests({
  catalog,
  meId,
  onOpen,
}: {
  catalog: RemoteCatalog;
  meId: string;
  onOpen: (profileId: string, row: Row) => void;
}) {
  const { t } = useTranslation();
  const list = pendingRows(catalog);
  if (list.length === 0) return null;
  return (
    <section className="mb-[18px] grid gap-2.5">
      <h2 className="mk-sec-t">{t('remoteMcp.requests.title', { count: list.length })}</h2>
      {list.map((row) => {
        const profile = catalog.profiles.find((item) => item.id === row.registration.profile_id);
        const request = row.request;
        if (!profile || !request) return null;
        const by = personOf(request.requested_by, request.requested_by_email, meId);
        return (
          <div key={row.key} className="card mc-req">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mk-name">{profile.name}</span>
                <span className="badge">
                  {request.kind === 'params'
                    ? t('remoteMcp.requests.params')
                    : request.kind === 'replace_app'
                      ? t('remoteMcp.requests.replace')
                      : t('remoteMcp.requests.enable')}
                </span>
                <span className="badge mono">{request.organization}</span>
              </div>
              <div className="mk-meta mt-[3px]">
                {t('remoteMcp.requests.by', {
                  by: by === 'me' ? t('remoteMcp.requests.you') : (by ?? ''),
                  when: formatRelative(request.created_at),
                  toolsets: request.toolsets.length,
                  groups: request.groups.join(', '),
                })}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                onOpen(profile.id, row);
              }}
            >
              {t('remoteMcp.requests.review')} <ArrowRightIcon size={11} />
            </button>
          </div>
        );
      })}
    </section>
  );
}
