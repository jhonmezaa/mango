import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'violet' | 'accent';

interface Props {
  tone?: BadgeTone;
  title?: string;
  children: ReactNode;
}

/** Status pill (design `badge` and `badge-<tone>`). */
export function Badge({ tone = 'neutral', title, children }: Props) {
  return (
    <span className={tone === 'neutral' ? 'badge' : `badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}
