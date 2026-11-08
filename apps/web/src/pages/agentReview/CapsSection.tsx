import { useTranslation } from 'react-i18next';

import { Badge } from '../../components/Badge';
import { fieldChange, setChange, type Version } from './reviewModel';

const CODE_INTERPRETER = 'code_interpreter';
type Cap = 'code' | 'memory';
const CAPS: readonly Cap[] = ['code', 'memory'];

/**
 * «capacidades» (design round 41 memory.jsx `RvCaps`, TM-ME6): «Ejecutar código» and «Memoria»,
 * like the rest of what the version can use. A new agent shows both, «Encendida» or «Apagada»;
 * a change shows only what changed, «Se enciende» or «Se apaga»; without changes, one line.
 * What changed comes from the server's diff (`capabilities` and `memory`), never compared here.
 */
export function CapsSection({
  version,
  memoryEnabled,
}: {
  version: Version;
  /** The installation's memory (`/api/me`): off, an approved «Memoria» remembers nothing. */
  memoryEnabled: boolean;
}) {
  const { t } = useTranslation();
  const { definition, diff } = version;
  const isNew = diff.is_new;
  const now: Record<Cap, boolean> = {
    code: definition.capabilities.includes(CODE_INTERPRETER),
    memory: definition.memory,
  };
  const code = setChange(diff, 'capabilities');
  const changed: Record<Cap, boolean> = {
    code: [...code.added, ...code.removed].includes(CODE_INTERPRETER),
    memory: fieldChange(diff, 'memory') !== null,
  };
  const rows = isNew ? CAPS : CAPS.filter((cap) => changed[cap]);
  const count = rows.length;
  const title = isNew
    ? t('agentReview.caps.title')
    : count
      ? t('agentReview.caps.titleChanged', { count })
      : t('agentReview.caps.titleSame');
  const yesNo = (on: boolean) => (on ? t('agentReview.caps.yes') : t('agentReview.caps.no'));
  return (
    <section>
      <h3 className="mk-sec-t">{title}</h3>
      <ul className="rv-tools">
        {rows.map((cap) => {
          const on = now[cap];
          const kind = on ? 'add' : isNew ? '' : 'rem';
          return (
            <li key={cap} className={kind ? `rv-tool ${kind}` : 'rv-tool'}>
              <span className="rv-sign" aria-hidden="true">
                {on ? '+' : isNew ? '·' : '−'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="rv-cap-name">{t(`agentReview.caps.${cap}.label`)}</span>
                <span className="mk-meta block">{t(`agentReview.caps.${cap}.sub`)}</span>
              </span>
              <Badge tone={on ? 'amber' : 'neutral'}>
                {isNew
                  ? on
                    ? t('agentReview.caps.on')
                    : t('agentReview.caps.off')
                  : on
                    ? t('agentReview.caps.turnsOn')
                    : t('agentReview.caps.turnsOff')}
              </Badge>
            </li>
          );
        })}
        {!isNew && count === 0 && (
          <li className="mk-meta rv-none">
            {t('agentReview.caps.same', { code: yesNo(now.code), memory: yesNo(now.memory) })}
          </li>
        )}
      </ul>
      {now.memory && (isNew || changed.memory) && !memoryEnabled && (
        <div className="mk-meta rv-cap-note">{t('agentReview.caps.memoryOff')}</div>
      )}
    </section>
  );
}
