import type { ReactNode } from 'react';

interface Props {
  /** Design `mc-alert` (neutral), `mc-alert amber` and `mc-alert red`. */
  tone?: 'neutral' | 'amber' | 'red';
  /** Leading icon; without it the content takes the whole width (design `display: block`). */
  icon?: ReactNode;
  /** `alert` announces the message at once; use it only for errors the user must act on. */
  role?: 'alert' | 'status';
  className?: string;
  children: ReactNode;
}

/** Inline notice of the marketplace screens (design `mc-alert`). Content is rendered as text. */
export function Alert({ tone = 'neutral', icon, role, className, children }: Props) {
  const classes = ['mc-alert'];
  if (tone !== 'neutral') classes.push(tone);
  if (!icon) classes.push('mc-alert-block');
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} role={role}>
      {icon}
      <div>{children}</div>
    </div>
  );
}
