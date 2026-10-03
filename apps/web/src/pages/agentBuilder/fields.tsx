import { useId, type ReactNode } from 'react';

import type { SectionId } from './model';

interface SectionProps {
  id: SectionId;
  title: string;
  desc: string;
  children: ReactNode;
}

/** One block of the form (design `ABSection`); its id is the anchor of the side navigation. */
export function BuilderSection({ id, title, desc, children }: SectionProps) {
  const headingId = `ab-${id}-title`;
  return (
    <section id={`ab-${id}`} className="ab-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <p className="ab-desc">{desc}</p>
      <div className="ab-section-body">{children}</div>
    </section>
  );
}

interface FieldProps {
  label: string;
  hint?: string | undefined;
  error?: string | false | null | undefined;
  /**
   * Receives the id of the label (a group of buttons takes it as `aria-labelledby`) and the id
   * to give a single control so the `<label>` points at it.
   */
  children: (ids: { labelId: string; controlId: string; errorId: string | undefined }) => ReactNode;
  /** True when the field is one control: the label is a `<label for>`. */
  control?: boolean;
}

/** Label, hint and error around a control (design `ABField`). */
export function BuilderField({ label, hint, error, children, control = false }: FieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const controlId = `${id}-control`;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={error ? 'ab-field has-error' : 'ab-field'}>
      <div className="ab-field-head">
        {control ? (
          <label id={labelId} htmlFor={controlId} className="ab-label">
            {label}
          </label>
        ) : (
          <span id={labelId} className="ab-label">
            {label}
          </span>
        )}
        {hint && <span className="ab-hint">{hint}</span>}
      </div>
      {children({ labelId, controlId, errorId })}
      {error && (
        <div id={errorId} className="ab-error">
          {error}
        </div>
      )}
    </div>
  );
}
