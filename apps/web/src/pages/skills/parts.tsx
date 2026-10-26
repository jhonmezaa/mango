import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '../../components/Badge';
import { LEVEL_TONE } from '../mcpCatalog/model';
import { instructionParts, type DataTier, type Skill, type SkillServer } from './model';

// Small pieces of the Skills screen (design skills.jsx `SkInstructions`, `McpLevel`, `sk-mcp`).

/**
 * The instructions of a skill (design `SkInstructions`): plain text in a `<pre>`, with each
 * `{{variable}}` in a `<mark>`. Never Markdown nor HTML: another person wrote them.
 */
export function Instructions({ text }: { text: string }) {
  return (
    <pre className="sk-ins">
      {instructionParts(text).map((part, index) =>
        part.variable ? (
          // The parts are the text in order: their place identifies them.
          <mark key={index}>{part.text}</mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </pre>
  );
}

/** Data level of a skill or of one of its servers (design `McpLevel`). */
export function LevelBadge({ tier }: { tier: DataTier }) {
  const { t } = useTranslation();
  return <Badge tone={LEVEL_TONE[tier]}>{t(`mcpCatalog.levels.${tier}`)}</Badge>;
}

/** «+ escritura» next to a level below write (design). */
export function WritesBadge({ skill }: { skill: Pick<Skill, 'writes' | 'data_tier'> }) {
  const { t } = useTranslation();
  if (!skill.writes || skill.data_tier === 'write') return null;
  return (
    <Badge tone="amber" title={t('skills.plusWriteTitle')}>
      {t('skills.plusWrite')}
    </Badge>
  );
}

/** A server of a skill in the catalog row (design `sk-mcp`). */
export function ServerChip({ server }: { server: SkillServer }) {
  const { t } = useTranslation();
  const title =
    server.name === null
      ? t('skills.serverMissing')
      : server.enabled
        ? t('skills.serverOn')
        : t('skills.serverOff');
  return (
    <span className={server.enabled ? 'sk-mcp' : 'sk-mcp off'} title={title}>
      <span className={server.enabled ? 'dot dot-green' : 'dot dot-red'} />
      {server.name ?? server.id}
    </span>
  );
}

export function Chips({ items, mono = false }: { items: readonly string[]; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {items.map((item) =>
        mono ? (
          <code key={item} className="mc-tool-chip">
            {item}
          </code>
        ) : (
          <Badge key={item}>{item}</Badge>
        ),
      )}
    </div>
  );
}

export function Line({ children }: { children: ReactNode }) {
  return <div className="mk-line flex items-start justify-between gap-3">{children}</div>;
}
