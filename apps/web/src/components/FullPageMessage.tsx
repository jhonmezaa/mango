import type { ReactNode } from 'react';

export function FullPageMessage({
  message,
  busy = false,
  children,
}: {
  message: string;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg p-6 text-center">
      <span className="sb-ws-logo" aria-hidden="true">
        m
      </span>
      <p
        className={busy ? 'flex items-center gap-2.5 text-muted' : 'text-[14px] text-text'}
        role={busy ? 'status' : 'alert'}
      >
        {busy && <span className="spinner" aria-hidden="true" />}
        {message}
      </p>
      {children}
    </div>
  );
}
