import type { ComponentType, ReactNode } from 'react';

import type { IconProps } from './icons';

export type StateTone = 'amber' | 'red' | 'muted';

const TONE_COLOR: Record<StateTone, string> = {
  amber: 'text-warn',
  red: 'text-danger',
  muted: 'text-muted',
};

interface Props {
  icon: ComponentType<IconProps>;
  tone?: StateTone;
  title: string;
  description?: string;
  actions?: ReactNode;
  /** `alert` for failures, `status` for neutral states such as "not found". */
  role?: 'alert' | 'status';
  /** `h2` when the page already has its own `h1`. */
  headingLevel?: 'h1' | 'h2';
  /** Technical reference shown in the design's monospace box (e.g. `HTTP 403`). */
  code?: string;
}

/** Full-area error/empty state (design: system.jsx ErrorState). */
export function ErrorState({
  icon: Icon,
  tone = 'amber',
  title,
  description,
  actions,
  role = 'alert',
  headingLevel: Heading = 'h1',
  code,
}: Props) {
  return (
    <div className="state" role={role}>
      <div className="state-inner">
        <div className={`state-icon ${TONE_COLOR[tone]}`}>
          <Icon size={20} />
        </div>
        <Heading className="state-title">{title}</Heading>
        {description && <p className="state-desc">{description}</p>}
        {actions && (
          <div className={code ? 'state-actions' : 'flex flex-wrap gap-2'}>{actions}</div>
        )}
        {code && (
          <div className="state-meta">
            <span>{code}</span>
          </div>
        )}
      </div>
    </div>
  );
}
