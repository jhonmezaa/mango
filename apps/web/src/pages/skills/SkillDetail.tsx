import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useSession } from '../../auth/useSession';
import { GovErrorState, Skel } from '../../components/admin/govKit';
import { Badge } from '../../components/Badge';
import { CopyIcon, EditIcon, ErrorCircleIcon, LockIcon, SkillIcon } from '../../components/icons';
import { SidePanel } from '../../components/SidePanel';
import { formatRelative } from '../../lib/format';
import { Section } from '../knowledge/parts';
import {
  currentOf,
  variablesOf,
  type Decision,
  type Skill,
  type SkillChange,
  type SkillDetail as Detail,
} from './model';
import { Chips, Instructions, LevelBadge, Line } from './parts';
import { SkillChangeList } from './SkillChangeList';

type LoadState = { kind: 'loading' } | { kind: 'ready'; detail: Detail } | { kind: 'error' };

interface Props {
  skill: Skill;
  /** Changes when the catalog was read again: the panel reads its skill again too. */
  revision: number;
  canEdit: boolean;
  canApprove: boolean;
  /** Duplicating is busy until the API answers. */
  duplicating: boolean;
  onClose: () => void;
  onNewVersion: (detail: Detail) => void;
  onDuplicate: (detail: Detail) => void;
  onDecide: (change: SkillChange, decision: Decision) => Promise<boolean>;
}

/**
 * Detail of a skill (design `SkillDetail`): its instructions as text, the MCP servers it needs,
 * the agents that use it with their version, its owner and its versions. «Nueva versión» and
 * «Duplicar como instrucciones» propose a request that a different administrator approves.
 */
export function SkillDetail({
  skill,
  revision,
  canEdit,
  canApprove,
  duplicating,
  onClose,
  onNewVersion,
  onDuplicate,
  onDecide,
}: Props) {
  const { t } = useTranslation();
  const { api } = useSession();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [retries, setRetries] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api
      .call('getSkillDetail', { path: { skill_id: skill.id } }, { signal: controller.signal })
      .then(
        (detail) => {
          setState({ kind: 'ready', detail });
        },
        () => {
          if (!controller.signal.aborted) setState({ kind: 'error' });
        },
      );
    return () => {
      controller.abort();
    };
  }, [api, skill.id, revision, retries]);

  const detail = state.kind === 'ready' ? state.detail : null;
  const off = skill.servers.filter((server) => !server.enabled);
  const pending = skill.pending !== null;
  const versions = detail ? detail.versions.toSorted((a, b) => b.version - a.version) : [];
  const last = versions[0];
  const vars = detail ? variablesOf(detail.instructions) : [];
  const owner = detail?.versions.find((version) => version.version === 1);
  const pendingChanges = detail
    ? detail.changes.filter((change) => change.status === 'pending')
    : [];

  return (
    <SidePanel
      title={skill.name}
      width={540}
      lead={
        <span className="mc-ic lg">
          <SkillIcon size={20} />
        </span>
      }
      meta={
        <>
          <Badge tone={skill.available ? 'green' : 'red'}>
            {skill.available ? t('skills.detail.available') : t('skills.detail.unavailable')}
          </Badge>
          <LevelBadge tier={skill.data_tier} />
          <span className="mk-meta">
            {t('skills.detail.meta', { category: skill.category, version: skill.version })}
          </span>
        </>
      }
      footer={
        canEdit ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={pending || !detail}
              title={pending ? t('skills.detail.alreadyPending') : undefined}
              onClick={() => {
                if (detail) onNewVersion(detail);
              }}
            >
              <EditIcon size={12} />
              {t('skills.detail.newVersion')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!detail || duplicating}
              onClick={() => {
                if (detail) onDuplicate(detail);
              }}
            >
              <CopyIcon size={12} />
              {t('skills.detail.duplicate')}
            </button>
          </div>
        ) : undefined
      }
      onClose={onClose}
    >
      <p className="sk-desc">{skill.description}</p>
      {off.length > 0 ? (
        <div className="mc-alert red">
          <ErrorCircleIcon size={14} />
          <div>
            {t('skills.detail.requires', {
              servers: off
                .map((server) =>
                  t('skills.detail.requiresServer', {
                    name: server.name ?? server.id,
                    status:
                      server.name === null
                        ? t('skills.detail.statusMissing')
                        : t('skills.detail.statusOff'),
                  }),
                )
                .join(', '),
            })}{' '}
            <Link className="sr-link" to="/mcp">
              {t('skills.detail.seeCatalog')}
            </Link>
          </div>
        </div>
      ) : null}
      {skill.writes ? (
        <div className="mc-alert amber">
          <LockIcon size={14} />
          <div>{t('skills.detail.writes')}</div>
        </div>
      ) : null}
      {state.kind === 'error' ? (
        <GovErrorState
          title={t('skills.detail.loadError')}
          body={t('skills.loadErrorBody')}
          onRetry={() => {
            setState({ kind: 'loading' });
            setRetries((value) => value + 1);
          }}
        />
      ) : detail === null ? (
        <div role="status" aria-label={t('skills.loading')} className="grid gap-3">
          <Skel h={120} className="rounded-lg" />
          <Skel w="60%" />
          <Skel w="80%" />
        </div>
      ) : (
        <>
          <SkillChangeList
            title={t('skills.detail.versionInApproval')}
            changes={pendingChanges}
            current={currentOf(detail)}
            canApprove={canApprove}
            onDecide={onDecide}
          />
          <Section title={t('skills.detail.instructions')}>
            <Instructions text={detail.instructions} />
          </Section>
          <Section title={t('skills.detail.variables', { count: vars.length })}>
            {vars.length ? (
              <Chips items={vars} mono />
            ) : (
              <div className="mk-meta">{t('skills.detail.noVariables')}</div>
            )}
          </Section>
          {detail.outputs.length > 0 ? (
            <Section title={t('skills.detail.outputs')}>
              <Chips items={detail.outputs} />
            </Section>
          ) : null}
          <Section title={t('skills.detail.servers', { count: skill.servers.length })}>
            {skill.servers.map((server) => (
              <Line key={server.id}>
                <div className="min-w-0">
                  <div className="font-medium">{server.name ?? server.id}</div>
                  <div className="mk-meta">
                    {server.name === null
                      ? t('skills.detail.serverNotInCatalog')
                      : t('skills.detail.serverTools', {
                          count: server.tools,
                          kind: server.writes
                            ? t('skills.detail.serverWrites')
                            : t('skills.detail.serverReadOnly'),
                        })}
                  </div>
                </div>
                <span className="flex items-center gap-1">
                  {server.data_tier ? <LevelBadge tier={server.data_tier} /> : null}
                  <Badge tone={server.enabled ? 'green' : 'red'}>
                    {server.name === null
                      ? t('skills.detail.statusMissingBadge')
                      : server.enabled
                        ? t('skills.detail.statusEnabled')
                        : t('skills.detail.statusDisabled')}
                  </Badge>
                </span>
              </Line>
            ))}
          </Section>
          <Section title={t('skills.detail.agents', { count: detail.agents_using.length })}>
            {detail.agents_using.length ? (
              detail.agents_using.map((agent) => (
                <Line key={agent.id}>
                  <span>{agent.name}</span>
                  <span className="mk-meta">
                    <span className="mono">v{agent.skill_version}</span>
                    {agent.skill_version < skill.version ? (
                      <span className="text-warn">
                        {t('skills.detail.agentOutdated', { version: skill.version })}
                      </span>
                    ) : (
                      t('skills.detail.agentCurrent')
                    )}
                  </span>
                </Line>
              ))
            ) : (
              <div className="mk-meta">{t('skills.detail.noAgents')}</div>
            )}
          </Section>
          <Section title={t('skills.detail.usage')}>
            <div className="mk-kv">
              <span title={t('skills.detail.runsTitle')}>{t('skills.detail.runs')}</span>
              <span className="mono">
                {skill.runs_30d ? skill.runs_30d.toLocaleString('es-ES') : t('skills.noData')}
              </span>
            </div>
            <div className="mk-kv">
              <span>{t('skills.detail.owner')}</span>
              <span>
                {t('skills.detail.ownerValue', {
                  who:
                    owner?.proposed_by_email ??
                    skill.owner_email ??
                    owner?.proposed_by ??
                    skill.owner ??
                    '—',
                })}
              </span>
            </div>
            {last ? (
              <div className="mk-kv">
                <span>{t('skills.detail.lastVersion')}</span>
                <span>
                  {t('skills.detail.lastVersionValue', {
                    version: last.version,
                    who: last.approved_by_email ?? last.approved_by,
                    ago: formatRelative(last.approved_at),
                  })}
                </span>
              </div>
            ) : null}
          </Section>
          {versions.length > 0 ? (
            <Section title={t('skills.detail.versions', { count: versions.length })}>
              {versions.map((version) => (
                <div key={version.version} className="mk-line sk-version">
                  <span className="mono font-semibold">v{version.version}</span>
                  <span className="mk-meta [overflow-wrap:anywhere]">
                    {t('skills.detail.versionRow', {
                      by: version.proposed_by_email ?? version.proposed_by,
                      approver: version.approved_by_email ?? version.approved_by,
                    })}
                  </span>
                  <span className="mk-meta">{formatRelative(version.approved_at)}</span>
                </div>
              ))}
            </Section>
          ) : null}
        </>
      )}
    </SidePanel>
  );
}
