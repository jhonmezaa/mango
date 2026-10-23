import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Alert } from '../../components/Alert';
import { CheckIcon, WarnIcon } from '../../components/icons';
import {
  badgeClass,
  formatBytes,
  formatCount,
  shownStatus,
  statusKey,
  type KnowledgeBase,
} from '../knowledge/model';
import { BuilderSection } from './fields';
import type { Definition } from './model';

/** At most this many knowledge bases per version (D88 (35)). */
export const MAX_KNOWLEDGE_BASES = 5;

type Change = (patch: Partial<Definition>) => void;

interface Props {
  selected: readonly string[];
  /** The knowledge bases the caller sees; null when they could not be read. */
  knowledge: readonly KnowledgeBase[] | null;
  agentGroups: readonly string[];
  userCount: number;
  myGroups: readonly string[];
  onChange: Change;
}

function toggled(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

/**
 * «Knowledge bases» of the Agent Builder (design `KbAgentSection`, D88 (35)). It offers only the
 * ones its author may use: in their groups and not being deleted. One the version already had and
 * the author cannot use stays, and says why. Which groups would get answers without its content
 * is computed here from the groups chosen (D26 «Acceso parcial»). Hints only: the API checks
 * every knowledge base that enters a version.
 */
export const KnowledgeSection = memo(function KnowledgeSection({
  selected,
  knowledge,
  agentGroups,
  userCount,
  myGroups,
  onChange,
}: Props) {
  const { t } = useTranslation();
  const byId = new Map((knowledge ?? []).map((kb) => [kb.kb_id, kb]));
  const usable = (knowledge ?? []).filter(
    (kb) => kb.status !== 'deleting' && kb.groups.some((group) => myGroups.includes(group)),
  );
  const usableIds = new Set(usable.map((kb) => kb.kb_id));
  const kept = knowledge === null ? [] : selected.filter((id) => !usableIds.has(id));
  const full = selected.length >= MAX_KNOWLEDGE_BASES;
  const gaps = selected.flatMap((id) => {
    const kb = byId.get(id);
    if (!kb) return [];
    const groups = agentGroups.filter((group) => !kb.groups.includes(group));
    return groups.length ? [{ kb, groups }] : [];
  });
  const remove = (id: string) => {
    onChange({ knowledge_bases: selected.filter((item) => item !== id) });
  };

  return (
    <BuilderSection
      id="kbs"
      title={t('agentBuilder.sections.kbs')}
      desc={t('agentBuilder.kbs.desc')}
    >
      {kept.length > 0 && (
        <Alert tone="neutral">
          <div className="ab-notice-title">
            {kept.length === 1 ? t('agentBuilder.kbs.keptOne') : t('agentBuilder.kbs.keptMany')}
          </div>
          {kept.map((id) => {
            const kb = byId.get(id);
            return (
              <div key={id} className="ab-off-row">
                <span>{kb ? kb.name : <span className="mono">{id}</span>}</span>
                <span className="flex items-center gap-2">
                  <span className="mk-meta">
                    {!kb
                      ? t('agentBuilder.kbs.gone')
                      : kb.status === 'deleting'
                        ? t('agentBuilder.kbs.deleting')
                        : t('agentBuilder.kbs.notMine')}
                  </span>
                  <button
                    type="button"
                    className="ab-link"
                    onClick={() => {
                      remove(id);
                    }}
                  >
                    {t('agentBuilder.actions.remove')}
                  </button>
                </span>
              </div>
            );
          })}
        </Alert>
      )}
      {knowledge === null ? (
        <div className="mk-meta">{t('agentBuilder.kbs.unavailable')}</div>
      ) : usable.length ? (
        <div className="ab-list ab-list-kbs">
          {usable.map((kb) => {
            const on = selected.includes(kb.kb_id);
            const disabled = !on && full;
            const status = shownStatus(kb);
            const classes = ['ab-item'];
            if (on) classes.push('is-on');
            if (disabled) classes.push('is-off');
            return (
              <button
                key={kb.kb_id}
                type="button"
                className={classes.join(' ')}
                disabled={disabled}
                aria-pressed={on}
                title={disabled ? t('agentBuilder.kbs.max') : undefined}
                onClick={() => {
                  onChange({ knowledge_bases: toggled(selected, kb.kb_id) });
                }}
              >
                <span className="ab-check">{on && <CheckIcon size={10} />}</span>
                <span className="ab-item-text">
                  <span className="ab-item-name">{kb.name}</span>
                  <span className="ab-sub">
                    {t(`knowledge.originShort.${kb.origin}`)}
                    {' · '}
                    {kb.documents
                      ? t('knowledge.size', {
                          documents: formatCount(kb.documents),
                          bytes: formatBytes(kb.bytes),
                        })
                      : '—'}
                    {' · '}
                    <span className="mono">{kb.groups.join(', ')}</span>
                  </span>
                </span>
                {status !== 'ok' && (
                  <span className={badgeClass(status)}>
                    {t(`knowledge.status.${statusKey(kb, status)}`)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mk-meta">{t('agentBuilder.kbs.none')}</div>
      )}
      {gaps.map(({ kb, groups }) => (
        <Alert key={kb.kb_id} tone="amber" icon={<WarnIcon size={14} />}>
          <b>{kb.name}:</b> <span className="mono">{groups.join(', ')}</span>{' '}
          {groups.length === 1 ? t('agentBuilder.kbs.gapOne') : t('agentBuilder.kbs.gapMany')}
        </Alert>
      ))}
      {selected.length > 0 && userCount > 0 && (
        <div className="mk-meta">{t('agentBuilder.kbs.users')}</div>
      )}
      <div className="ab-foot">
        <span>{t('agentBuilder.kbs.count', { count: selected.length })}</span>
        <Link to="/knowledge" className="ab-link">
          {t('agentBuilder.kbs.link')}
        </Link>
      </div>
    </BuilderSection>
  );
});
