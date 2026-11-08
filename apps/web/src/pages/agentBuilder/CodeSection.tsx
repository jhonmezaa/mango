import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { Definition } from './model';
import { CheckIcon } from '../../components/icons';
import { BuilderSection } from './fields';

const CODE_INTERPRETER = 'code_interpreter';

interface Props {
  capabilities: readonly string[];
  onChange: (patch: Partial<Definition>) => void;
}

/**
 * Design round 40 (D114 (6)): «Ejecutar código», after Knowledge bases. The capability is part of
 * the version and is approved like the rest of it; the API decides whether the installation can
 * run code (`code_interpreter_unavailable`), never this page.
 */
export const CodeSection = memo(function CodeSection({ capabilities, onChange }: Props) {
  const { t } = useTranslation();
  const on = capabilities.includes(CODE_INTERPRETER);
  return (
    <BuilderSection
      id="code"
      title={t('agentBuilder.sections.code')}
      desc={t('agentBuilder.code.desc')}
    >
      <button
        type="button"
        className={on ? 'ab-item is-on' : 'ab-item'}
        aria-pressed={on}
        onClick={() => {
          onChange({
            capabilities: on
              ? capabilities.filter((item) => item !== CODE_INTERPRETER)
              : [...capabilities, CODE_INTERPRETER],
          } as Partial<Definition>);
        }}
      >
        <span className="ab-check">{on && <CheckIcon size={10} />}</span>
        <span className="ab-item-text">
          <span className="ab-item-name">{t('agentBuilder.code.label')}</span>
          <span className="ab-sub">{t('agentBuilder.code.sub')}</span>
        </span>
      </button>
    </BuilderSection>
  );
});
