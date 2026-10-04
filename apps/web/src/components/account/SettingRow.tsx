import type { ReactNode } from 'react';

/** One row of a General section: label and hint on the left, value on the right (design `SRow`). */
export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="set-row">
      <div>
        <div className="set-row-label">{label}</div>
        {hint && <div className="set-row-hint">{hint}</div>}
      </div>
      <div className="set-row-value">{children}</div>
    </div>
  );
}
