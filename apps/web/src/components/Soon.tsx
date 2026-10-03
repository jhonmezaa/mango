import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** "Próximamente" pill (design: avail.jsx SoonTag). */
export function SoonTag() {
  const { t } = useTranslation();
  return <span className="soon-tag">{t('soon.tag')}</span>;
}

interface SoonProps {
  children: ReactNode;
  /** Accessible name of the disabled control (the dimmed content is inert and hidden from AT). */
  name: string;
  block?: boolean;
  className?: string;
}

/**
 * Wraps a control that exists in the design but not in the product yet (design: avail.jsx Soon).
 * The content stays visible but dimmed and `inert` (not focusable or clickable); assistive
 * technology hears "<name>, próximamente".
 */
export function Soon({ children, name, block = false, className }: SoonProps) {
  const { t } = useTranslation();
  const Tag = block ? 'div' : 'span';
  const classes = ['soon'];
  if (block) classes.push('soon-block');
  if (className) classes.push(className);
  return (
    <Tag className={classes.join(' ')} title={t('soon.title')}>
      <Tag className="soon-body" aria-hidden="true" inert>
        {children}
      </Tag>
      <span className="sr-only">{name}</span>
      <SoonTag />
    </Tag>
  );
}
