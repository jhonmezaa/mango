import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useSession } from '../../auth/useSession';
import { Alert } from '../../components/Alert';
import { CloseIcon, SkillIcon, WarnIcon } from '../../components/icons';
import type { SkillsList } from '../skills/model';
import { BuilderSection } from './fields';
import {
  MAX_SKILLS,
  parseSkillRef,
  skillIssues,
  skillRef,
  type Definition,
  type SkillIssue,
} from './model';

type Change = (patch: Partial<Definition>) => void;

interface Props {
  selected: readonly string[];
  /** The approved skills; null when they could not be read. */
  skills: SkillsList | null;
  /** Tools of the version: a skill needs one of each of its servers. */
  tools: readonly string[];
  onChange: Change;
}

function IssueLine({ issue, name }: { issue: SkillIssue; name: string }) {
  const { t } = useTranslation();
  const text =
    issue.kind === 'unapproved'
      ? t('agentBuilder.problems.skillUnapproved', {
          items: `${name} v${String(issue.version)}`,
        })
      : t(
          issue.kind === 'serverOff'
            ? 'agentBuilder.problems.skillServerOff'
            : 'agentBuilder.problems.skillServerMissing',
          { items: name, tools: issue.server },
        );
  return (
    <span className={issue.kind === 'serverMissing' ? 'ab-sk-issue is-warn' : 'ab-sk-issue'}>
      {text}
    </span>
  );
}

/**
 * «Skills» of the Agent Builder (design `SkAgentSection`, D92). Each one is pinned to an approved
 * version (`id@vN`): a newer one shows «v{m} disponible» and «Pasar a v{m}». New ones are added
 * at their latest approved version; those that rely on a server that is not enabled cannot be
 * chosen. Hints only: the API checks every skill when the version is sent.
 */
export const SkillsSection = memo(function SkillsSection({
  selected,
  skills: loaded,
  tools,
  onChange,
}: Props) {
  const { t } = useTranslation();
  const { api } = useSession();
  // «Reintentar» reads the list again here: the rest of the form keeps what was written.
  const [reread, setReread] = useState<SkillsList | null>(null);
  const [retrying, setRetrying] = useState(false);
  const skills = reread ?? loaded;
  const retry = () => {
    setRetrying(true);
    api.call('getSkills').then(
      (data) => {
        setReread(data);
        setRetrying(false);
      },
      () => {
        setRetrying(false);
      },
    );
  };
  const max = skills?.max_per_agent ?? MAX_SKILLS;
  const byId = new Map((skills?.items ?? []).map((skill) => [skill.id, skill]));
  const chosen = new Set(selected.map((ref) => parseSkillRef(ref).id));
  const options = (skills?.items ?? [])
    .filter((skill) => !chosen.has(skill.id))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const full = selected.length >= max;
  const replace = (ref: string, next: string | null) => {
    onChange({
      skills: next
        ? selected.map((item) => (item === ref ? next : item))
        : selected.filter((item) => item !== ref),
    });
  };

  return (
    <BuilderSection
      id="skills"
      title={t('agentBuilder.sections.skills')}
      desc={t('agentBuilder.skills.desc')}
    >
      {skills === null ? (
        <Alert tone="amber" role="alert" icon={<WarnIcon size={14} />}>
          {t('agentBuilder.skills.unavailable')}
          <div className="mt-2">
            <button type="button" className="btn btn-sm" disabled={retrying} onClick={retry}>
              {t('agentBuilder.skills.retry')}
            </button>
          </div>
        </Alert>
      ) : null}
      {selected.length > 0 ? (
        <div className="card ab-sk-list">
          {selected.map((ref) => {
            const { id, version } = parseSkillRef(ref);
            const skill = byId.get(id);
            const name = skill?.name ?? id;
            const latest = skill?.version ?? 0;
            const issues = skills === null ? [] : skillIssues(ref, skill, tools);
            return (
              <div key={ref} className="mk-line ab-sk-row">
                <span className="mc-ic">
                  <SkillIcon size={13} />
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <b className="font-medium">{name}</b>
                    <span className="mono mk-meta">
                      {id}@v{version}
                    </span>
                    {latest > version ? (
                      <span className="badge badge-amber">
                        {t('agentBuilder.skills.available', { version: latest })}
                      </span>
                    ) : null}
                  </span>
                  {skill ? (
                    <span className="mk-meta block">
                      {skill.servers.map((server) => server.name ?? server.id).join(' · ')}
                    </span>
                  ) : null}
                  {issues.map((issue) => (
                    <IssueLine
                      key={`${issue.kind}:${'server' in issue ? issue.server : ''}`}
                      issue={issue}
                      name={name}
                    />
                  ))}
                </span>
                <span className="flex items-center gap-1">
                  {skill && latest > version ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        replace(ref, skillRef(skill));
                      }}
                    >
                      {t('agentBuilder.skills.upgrade', { version: latest })}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label={t('agentBuilder.skills.remove', { name })}
                    onClick={() => {
                      replace(ref, null);
                    }}
                  >
                    <CloseIcon size={12} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mk-meta">{t('agentBuilder.skills.none')}</div>
      )}
      <div className="ab-sk-add">
        <select
          className="input"
          value=""
          disabled={skills === null || full || options.length === 0}
          aria-label={t('agentBuilder.skills.addLabel')}
          onChange={(event) => {
            const { value } = event.target;
            if (value) onChange({ skills: [...selected, value] });
          }}
        >
          <option value="">
            {full
              ? t('agentBuilder.skills.full', { max })
              : options.length
                ? t('agentBuilder.skills.add')
                : t('agentBuilder.skills.noneLeft')}
          </option>
          {options.map((skill) => (
            <option key={skill.id} value={skillRef(skill)} disabled={!skill.available}>
              {t(skill.available ? 'agentBuilder.skills.option' : 'agentBuilder.skills.optionOff', {
                name: skill.name,
                version: skill.version,
              })}
            </option>
          ))}
        </select>
        <span className="mk-meta">
          {t('agentBuilder.skills.count', { count: selected.length, max })}
        </span>
        <Link to="/skills" className="ab-link">
          {t('agentBuilder.skills.link')}
        </Link>
      </div>
      <div className="mk-meta leading-normal">{t('agentBuilder.skills.hint')}</div>
    </BuilderSection>
  );
});
