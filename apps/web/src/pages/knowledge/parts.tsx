import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { CheckIcon, ClockIcon, ErrorCircleIcon, InfoIcon, WarnIcon } from '../../components/icons';
import {
  SCHEDULES,
  badgeClass,
  isSpinning,
  shownStatus,
  statusKey,
  type KnowledgeBase,
  type Schedule,
} from './model';

/** A section of the panel (design `MkSec`). */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mk-sec">
      <h3 className="mk-sec-t">{title}</h3>
      {children}
    </section>
  );
}

export function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mk-kv">
      <span>{label}</span>
      {children}
    </div>
  );
}

type Tone = 'info' | 'amber' | 'red' | 'clock' | 'busy';

const ICONS = { info: InfoIcon, amber: WarnIcon, red: ErrorCircleIcon, clock: ClockIcon };

/** A notice of the panel (design `mc-alert`, with its icon). */
export function Notice({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  const color = tone === 'amber' || tone === 'clock' ? ' amber' : tone === 'red' ? ' red' : '';
  const Icon = tone === 'busy' ? null : ICONS[tone];
  return (
    <div
      className={`mc-alert${color}${className ? ` ${className}` : ''}`}
      role={tone === 'busy' ? 'status' : undefined}
    >
      {Icon ? <Icon size={14} /> : <span className="g-spin" aria-hidden="true" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** The groups to choose, as chips (design `tweak-chip ab-chip`). */
export function GroupChips({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: readonly string[];
  value: readonly string[];
  onChange: (groups: readonly string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  // A chosen group the list does not bring (it could not be read) is still shown.
  const shown = [...options, ...value.filter((group) => !options.includes(group))];
  return (
    <div
      className="row flex-wrap gap-1"
      role="group"
      aria-label={t('knowledge.access.groupsLabel')}
    >
      {shown.map((group) => {
        const on = value.includes(group);
        return (
          <button
            key={group}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            className={on ? 'ab-chip is-on' : 'ab-chip'}
            onClick={() => {
              onChange(on ? value.filter((item) => item !== group) : [...value, group]);
            }}
          >
            {on ? <CheckIcon size={10} /> : null}
            {group}
          </button>
        );
      })}
    </div>
  );
}

/** The frequency of a bucket (design `KB_FREQS`). */
export function ScheduleChips({
  value,
  onChange,
  disabled = false,
}: {
  value: Schedule;
  onChange: (schedule: Schedule) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="tk-quick inline-flex flex-wrap"
      role="group"
      aria-label={t('knowledge.access.frequencyLabel')}
    >
      {SCHEDULES.map((schedule) => (
        <button
          key={schedule}
          type="button"
          disabled={disabled}
          aria-pressed={value === schedule}
          className={value === schedule ? 'is-on' : undefined}
          onClick={() => {
            onChange(schedule);
          }}
        >
          {t(`knowledge.freqs.${schedule}`)}
        </button>
      ))}
    </div>
  );
}

/** The status of a knowledge base (design `kbStatus`). */
export function StatusBadge({ kb }: { kb: KnowledgeBase }) {
  const { t } = useTranslation();
  const status = shownStatus(kb);
  return (
    <span className={badgeClass(status)}>
      {isSpinning(status) ? (
        <span className="g-spin mr-[5px] h-[9px] w-[9px]" aria-hidden="true" />
      ) : null}
      {t(`knowledge.status.${statusKey(kb, status)}`)}
    </span>
  );
}
