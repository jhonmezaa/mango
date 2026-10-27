import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert } from '../../components/Alert';
import { Badge } from '../../components/Badge';
import { CheckIcon, WarnIcon } from '../../components/icons';
import { RmBadges } from '../remoteMcp/parts';
import type { CatalogRemote, Version } from './model';

type RemoteRef = NonNullable<Version['remotes']>[number];

interface Props {
  tools: readonly string[];
  /** Registrations of the caller's groups (GET /api/mcp/catalog `remotes`): the API filters. */
  remotes: readonly CatalogRemote[];
  /** The stored version's `remote_audience_outside_groups` notices (D98 (2), P-2). */
  audience: readonly RemoteRef[];
  groups: readonly string[];
  userCount: number;
  onChange: (tools: string[]) => void;
}

function toggled(list: readonly string[], ref: string): string[] {
  return list.includes(ref) ? list.filter((item) => item !== ref) : [...list, ref];
}

/**
 * Agent Builder › Tools › remote services (design remote-views.jsx `RemoteBuilderTools`). Only the
 * registrations the caller may give tools of come from the API (`UseRemoteMcp`, D93 (7)), so the
 * design's «no está habilitado para tus grupos» row never shows: the API does not tell the groups
 * of a registration to someone outside them. The notice about groups without the service is the
 * API's, from the last save; it does not block (P-2).
 */
export function RemoteTools({ tools, remotes, audience, groups, userCount, onChange }: Props) {
  const { t } = useTranslation();
  if (remotes.length === 0) return null;
  const selected = new Set(tools);
  return (
    <div className="ab-list ab-list-tools">
      {remotes.map((remote) => {
        const refs = remote.tools.filter((tool) => tool.enabled).map((tool) => tool.ref);
        const chosen = refs.filter((ref) => selected.has(ref)).length;
        const all = refs.length > 0 && chosen === refs.length;
        const outside = (
          audience.find((item) => item.registration_id === remote.registration_id)
            ?.groups_without_access ?? []
        ).filter((group) => groups.includes(group));
        return (
          <Fragment key={remote.registration_id}>
            <div className="ab-group flex-wrap">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="ab-group-name">{remote.service}</span>
                <span>{t('connections.builder.external', { org: remote.organization })}</span>
                {/* Every remote service is run by a third party outside AWS (D93). */}
                <RmBadges profile={{ data_leaves_aws: true, operator: remote.operator }} compact />
              </span>
              <button
                type="button"
                className="ab-link"
                onClick={() => {
                  onChange(
                    all
                      ? tools.filter((ref) => !refs.includes(ref))
                      : [...new Set([...tools, ...refs])],
                  );
                }}
              >
                {all ? t('agentBuilder.tools.none') : t('agentBuilder.tools.all')}
              </button>
            </div>
            {remote.tools
              .filter((tool) => tool.enabled)
              .map((tool) => {
                const on = selected.has(tool.ref);
                return (
                  <button
                    key={tool.ref}
                    type="button"
                    className={on ? 'ab-item is-on' : 'ab-item'}
                    aria-pressed={on}
                    onClick={() => {
                      onChange(toggled(tools, tool.ref));
                    }}
                  >
                    <span className="ab-check">{on && <CheckIcon size={10} />}</span>
                    <span className="ab-item-text">
                      <span className="mono ab-item-name">{tool.name}</span>
                      <span className="ab-sub">
                        {[tool.description, t('connections.builder.sub')]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <Badge>{t('connections.builder.read')}</Badge>
                  </button>
                );
              })}
            {chosen > 0 && (outside.length > 0 || userCount > 0) && (
              <Alert tone="amber" icon={<WarnIcon size={14} />}>
                {t('connections.builder.warnBefore')}
                {outside.length > 0 && (
                  <>
                    {t('connections.builder.warnGroups', { service: remote.service })}
                    <span className="mono">{outside.join(', ')}</span>
                    {t('connections.builder.warnGroupsAfter')}
                  </>
                )}
                {outside.length > 0 && userCount > 0 && t('connections.builder.warnAnd')}
                {userCount > 0 && t('connections.builder.warnUsers')}
                {t('connections.builder.warnAfter')}
              </Alert>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
