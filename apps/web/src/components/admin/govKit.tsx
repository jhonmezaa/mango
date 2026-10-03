import { useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useFocusTrap } from '../../hooks/useFocusTrap';
import {
  Check2Icon,
  CloseIcon,
  InboxIcon,
  InfoIcon,
  LockIcon,
  RefreshIcon,
  WarnIcon,
  X2Icon,
} from '../icons';
import { STATUS_BADGE, STATUS_COLOR, pctLabel, statusOf } from './govFormat';

// Building blocks of the governance screens (design: gov/kit.jsx). Every value is rendered as
// React text: emails, reasons and OU names come from other admins or AWS (TM-A8).

interface ModalProps {
  title: string;
  sub?: string | undefined;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Max width in px (design default 520). */
  width?: number;
  /** Full-screen sheet on phones (propose/approve/reject). */
  sheet?: boolean;
  /** Blocks closing (Escape, backdrop, close button) while a request is in flight. */
  busy?: boolean;
}

/** Governance dialog: portaled, focus trapped, Escape and backdrop close it (design `Modal`). */
export function GovModal({
  title,
  sub,
  onClose,
  children,
  footer,
  width = 520,
  sheet = false,
  busy = false,
}: ModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const subId = useId();
  const close = () => {
    if (!busy) onClose();
  };
  const ref = useFocusTrap<HTMLDivElement>(true, close);
  return createPortal(
    <div className="g-frame g-portal">
      <div
        className="g-overlay"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={sub ? subId : undefined}
          aria-busy={busy}
          className={sheet ? 'g-modal sheet' : 'g-modal'}
          style={{ maxWidth: width }}
        >
          <div className="g-modal-h">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="g-modal-t">
                {title}
              </h2>
              {sub && (
                <p id={subId} className="g-modal-s">
                  {sub}
                </p>
              )}
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={t('common.close')}
              onClick={close}
              disabled={busy}
            >
              <CloseIcon size={14} />
            </button>
          </div>
          <div className="g-modal-b">{children}</div>
          {footer && <div className="g-modal-f">{footer}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

type BannerTone = 'info' | 'warn' | 'error' | 'ok';
const BANNER_ICON = { info: InfoIcon, warn: WarnIcon, error: X2Icon, ok: Check2Icon };

export function Banner({
  tone = 'info',
  title,
  children,
}: {
  tone?: BannerTone;
  title?: string | undefined;
  children?: ReactNode;
}) {
  const Icon = BANNER_ICON[tone];
  return (
    <div
      className={`g-banner ${tone}`}
      role={tone === 'error' || tone === 'warn' ? 'alert' : 'status'}
    >
      <Icon size={15} className="mt-px shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <div className="g-banner-t">{title}</div>}
        {children && <div className="g-banner-b">{children}</div>}
      </div>
    </div>
  );
}

/** Why an action is not available (design `Reason`). */
export function Reason({
  children,
  tone,
  id,
}: {
  children: ReactNode;
  tone?: 'warn' | undefined;
  id?: string | undefined;
}) {
  const Icon = tone === 'warn' ? WarnIcon : LockIcon;
  return (
    <div id={id} className={tone ? `g-reason ${tone}` : 'g-reason'}>
      <Icon size={12} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function Bar({ percent }: { percent: number }) {
  return (
    <div className="g-bar" role="presentation">
      <span
        style={{
          width: `${String(Math.min(100, percent))}%`,
          background: STATUS_COLOR[statusOf(percent)],
        }}
      />
    </div>
  );
}

export function StatusBadge({ percent }: { percent: number }) {
  const { t } = useTranslation();
  const status = statusOf(percent);
  return <span className={`badge ${STATUS_BADGE[status]}`}>{t(`gov.status.${status}`)}</span>;
}

/** Budget preview: "Con este límite quedaría en…" with the bar (design UserModal preview). */
export function UsagePreview({ percent, children }: { percent: number; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="g-preview">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="g-sub">{t('gov.preview')}</span>
        <StatusBadge percent={percent} />
      </div>
      <div className="g-usage">
        <Bar percent={percent} />
        <span className="g-pct">{pctLabel(percent)}</span>
      </div>
      {children}
    </div>
  );
}

interface MoneyInputProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  hint?: string | undefined;
  disabled?: boolean;
  autoFocus?: boolean;
}

export function MoneyInput({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  disabled,
  autoFocus,
}: MoneyInputProps) {
  return (
    <div className="g-field">
      <label htmlFor={id}>{label}</label>
      <div className={`g-money${error ? ' has-error' : ''}${disabled ? ' is-disabled' : ''}`}>
        <span>USD</span>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          maxLength={20}
          value={value}
          disabled={disabled}
          data-autofocus={autoFocus ? '' : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-h`}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      </div>
      <div id={`${id}-h`} className={error ? 'g-err' : 'g-hint'}>
        {error ?? hint}
      </div>
    </div>
  );
}

export function Skel({
  w = '100%',
  h = 12,
  className,
}: {
  w?: number | string;
  h?: number;
  className?: string;
}) {
  return (
    <span
      className={className ? `g-skel ${className}` : 'g-skel'}
      style={{ width: w, height: h }}
      aria-hidden="true"
    />
  );
}

export function Empty({
  icon: Icon = InboxIcon,
  title,
  children,
  action,
}: {
  icon?: typeof InboxIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="g-empty">
      <span className="g-empty-i">
        <Icon size={18} />
      </span>
      <div className="g-empty-t">{title}</div>
      {children && <p className="g-empty-b">{children}</p>}
      {action}
    </div>
  );
}

export function GovErrorState({
  title,
  body,
  onRetry,
}: {
  title: string;
  body: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="g-card">
      <Empty
        icon={WarnIcon}
        title={title}
        action={
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            <RefreshIcon size={12} />
            {t('common.retry')}
          </button>
        }
      >
        {body}
      </Empty>
    </div>
  );
}

/** Shown when the account is not an admin (design `Denied`). The server authorizes anyway. */
export function Denied() {
  const { t } = useTranslation();
  return (
    <div className="g-denied">
      <Empty icon={LockIcon} title={t('gov.denied.title')}>
        {t('gov.denied.body')}
      </Empty>
    </div>
  );
}

export function Spinner() {
  return <span className="g-spin" aria-hidden="true" />;
}
