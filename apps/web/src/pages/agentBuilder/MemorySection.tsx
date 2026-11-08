import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { Definition } from './model';
import { CheckIcon } from '../../components/icons';
import { BuilderSection } from './fields';

interface Props {
  memory: boolean;
  /** The installation's memory (`/api/me`): off, the box is kept but nothing is remembered. */
  memoryEnabled: boolean;
  onChange: (patch: Partial<Definition>) => void;
}

/**
 * Design round 41 (D122, TM-ME6): «Memoria», after «Ejecutar código». Part of the version, so
 * turning it on goes through its approval, where the review shows it. The installation decides
 * whether anything is remembered (`AGENT_MEMORY_ENABLED`), never this page.
 */
export const MemorySection = memo(function MemorySection({
  memory,
  memoryEnabled,
  onChange,
}: Props) {
  const { t } = useTranslation();
  return (
    <BuilderSection
      id="memory"
      title={t('agentBuilder.sections.memory')}
      desc={t('agentBuilder.memory.desc')}
    >
      <button
        type="button"
        className={memory ? 'ab-item is-on' : 'ab-item'}
        aria-pressed={memory}
        onClick={() => {
          onChange({ memory: !memory });
        }}
      >
        <span className="ab-check">{memory && <CheckIcon size={10} />}</span>
        <span className="ab-item-text">
          <span className="ab-item-name">{t('agentBuilder.memory.label')}</span>
          <span className="ab-sub">{t('agentBuilder.memory.sub')}</span>
        </span>
      </button>
      {memory && !memoryEnabled && (
        <div className="mk-meta ab-memory-off">{t('agentBuilder.memory.off')}</div>
      )}
    </BuilderSection>
  );
});
