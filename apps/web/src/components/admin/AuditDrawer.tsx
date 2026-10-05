import { useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useFocusTrap } from '../../hooks/useFocusTrap';
import { formatRelative } from '../../lib/format';
import { ArrowRightIcon, CloseIcon, CopyIcon, FilterIcon, LockIcon, UserIcon } from '../icons';
import {
  isPermAction,
  isLateSessionEnd,
  isSessionEndReason,
  isSessionRejectCode,
  outcomeClass,
  TONE_COLOR,
  type AuditRow,
  type EventRef,
} from './auditModel';

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mk-sec">
      <h3 className="mk-sec-t">{title}</h3>
      {children}
    </section>
  );
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

interface Props {
  row: AuditRow;
  label: string;
  /** Design `ROLE_L` label, or '' when the event did not record the role. */
  role: string;
  detail: string;
  /** Design `auditOutcome` text ("no se aplicó · CODE"), or '' when the event has no outcome. */
  outcome: string;
  link: { to: string; label: string } | null;
  onClose: () => void;
  onActor: (actor: string) => void;
  onResource: (resource: { key: string; id: string }) => void;
  onLink: (to: string) => void;
  onCopy: () => void;
}

const refText = (ref: EventRef) => `${ref.id} · ${ref.event}`;

/** Side panel with one event (design `AuditDetail`); every value is rendered as text. */
export function AuditDrawer({
  row,
  label,
  role,
  detail,
  outcome,
  link,
  onClose,
  onActor,
  onResource,
  onLink,
  onCopy,
}: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const ref = useFocusTrap<HTMLElement>(true, onClose);
  const color = TONE_COLOR[row.tone];
  // Only fields whose value changed (a mapping event carries the whole before/after mapping).
  const keys = [
    ...new Set([...Object.keys(row.before ?? {}), ...Object.keys(row.after ?? {})]),
  ].filter((key) => fmt(row.before?.[key]) !== fmt(row.after?.[key]));
  const date = new Date(row.time).toLocaleString('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
  const actorName = row.actor ? (row.actor.split(' ')[0] ?? row.actor) : t('audit.system');
  const permLabel = (action: string) => (isPermAction(action) ? t(`audit.perms.${action}`) : null);
  // Access rows name the permission (design `AUDIT_PERMS`): "Recurso: `ViewAudit` · Ver auditoría".
  const perm =
    row.detail.kind === 'access' && row.action.startsWith('access.') ? row.detail.action : null;
  const permText = perm === null ? null : permLabel(perm);
  const authzText = row.authz ? permLabel(row.authz.action) : null;
  const start = row.turn?.start ?? null;
  // Design «Lectura»: what a read of the directory read, in words (never the raw keys).
  const read = row.detail.kind === 'directoryRead' ? row.detail.read : null;
  // The email may only break before the «@», never in the middle of a word (design `.au-mail`).
  const at = row.actor.indexOf('@');

  return createPortal(
    <div
      className="mk-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={ref}
        className="mk-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="mk-drawer-h">
          <span
            className="gv-ic"
            style={{ color, background: `color-mix(in oklab, ${color} 12%, transparent)` }}
          >
            <LockIcon size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[16px] font-semibold text-strong">
              {label}
            </h2>
            <div className="mk-meta mt-0.5">
              <span className="mono break-all">{row.raw.event_id}</span> · {date}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t('audit.drawer.copy')}
            title={t('audit.drawer.copy')}
            onClick={onCopy}
          >
            <CopyIcon size={13} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="mk-drawer-b">
          <p className="m-0 text-[14px] leading-[1.55] break-words">{detail}</p>
          <Sec title={t('audit.drawer.event')}>
            <div className="mk-kv">
              <span>{t('audit.drawer.actor')}</span>
              <span className="flex flex-wrap items-center gap-2">
                <span className="au-mail">
                  {at > 0 ? (
                    <>
                      {row.actor.slice(0, at)}
                      <wbr />
                      {row.actor.slice(at)}
                    </>
                  ) : (
                    row.actor || t('audit.system')
                  )}
                </span>
                {role && <span className="au-role">{role}</span>}
              </span>
            </div>
            <div className="mk-kv">
              <span>{t('audit.drawer.action')}</span>
              <span className="mono text-[12px] break-all">{row.event}</span>
            </div>
            {row.agentVersion !== null && (
              <div className="mk-kv">
                <span>{t('audit.drawer.agentVersion')}</span>
                <span className="mono text-[12px]">v{row.agentVersion}</span>
              </div>
            )}
            {row.model && (
              <div className="mk-kv">
                <span>{t('audit.drawer.model')}</span>
                <span className="mono text-[12px] [overflow-wrap:anywhere]">{row.model}</span>
              </div>
            )}
            <div className="mk-kv">
              <span>{t('audit.drawer.resource')}</span>
              <span className="mono text-[12px] break-all">
                {perm ?? row.resource ?? '—'}
                {permText && <span className="au-perm"> · {permText}</span>}
              </span>
            </div>
            {outcome && (
              <div className="mk-kv">
                <span>{t('audit.drawer.outcome')}</span>
                <span className={outcomeClass(row)}>{outcome}</span>
              </div>
            )}
            {row.endReason && (
              <div className="mk-kv">
                <span>{t('audit.drawer.reason')}</span>
                <span className="break-words">
                  {isSessionEndReason(row.endReason)
                    ? t(`audit.sessionEnd.${row.endReason}`)
                    : row.endReason}
                  {isLateSessionEnd(row.endReason) ? (
                    <span className="au-reason-note">{t('audit.sessionEndLate')}</span>
                  ) : null}
                </span>
              </div>
            )}
            {row.event === 'session.rejected' && row.error && isSessionRejectCode(row.error) ? (
              <div className="mk-kv">
                <span>{t('audit.drawer.reason')}</span>
                <span className="break-words">{t(`audit.sessionReject.${row.error}`)}</span>
              </div>
            ) : null}
            {row.requested && (
              <div className="mk-kv">
                <span>{t('audit.drawer.requested')}</span>
                <span className="au-steps">
                  {new Date(row.requested.ts).toLocaleTimeString('es-MX', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                  })}{' '}
                  · <span className="mono break-all">{row.requested.id}</span> ·{' '}
                  {t('audit.drawer.requestedNote')}
                </span>
              </div>
            )}
            <div className="mk-kv">
              <span>{t('audit.drawer.ago')}</span>
              <span>{formatRelative(row.ts)}</span>
            </div>
          </Sec>
          {read && (
            <Sec title={t('audit.drawer.read')}>
              <div className="mk-kv">
                <span>{t('audit.drawer.readWhat')}</span>
                <span>
                  {t(
                    read.scope === 'changes'
                      ? 'audit.drawer.readChanges'
                      : 'audit.drawer.readPeople',
                  )}
                </span>
              </div>
              <div className="mk-kv">
                <span>{t('audit.drawer.readReturned')}</span>
                <span>{read.returned ?? '—'}</span>
              </div>
              {read.scope === 'people' ? (
                <div className="mk-kv">
                  <span>{t('audit.drawer.readFilter')}</span>
                  <span>{read.filter ? t(`people.filters.${read.filter}`) : '—'}</span>
                </div>
              ) : null}
              {read.scope === 'people' ? (
                <div className="mk-kv">
                  <span>{t('audit.drawer.readSearched')}</span>
                  <span>
                    {t(
                      read.searched
                        ? 'audit.drawer.readSearchedYes'
                        : 'audit.drawer.readSearchedNo',
                    )}
                  </span>
                </div>
              ) : (
                <div className="mk-kv">
                  <span>{t('audit.drawer.readMissing')}</span>
                  <span>{read.missing}</span>
                </div>
              )}
            </Sec>
          )}
          {row.turn && start && (
            <Sec title={t('audit.drawer.turnStart')}>
              <div className="mk-kv">
                <span>{t('audit.drawer.turn')}</span>
                <span className="mono text-[12px] break-all">{row.turn.id}</span>
              </div>
              <div className="mk-kv">
                <span>{t('audit.drawer.event')}</span>
                <span className="mono text-[12px] break-all">{refText(start)}</span>
              </div>
              <div className="mk-kv">
                <span>{t('audit.drawer.time')}</span>
                <span>
                  {new Date(start.ts).toLocaleTimeString('es-MX', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                  })}
                </span>
              </div>
            </Sec>
          )}
          {row.authz && (
            <Sec title={t('audit.drawer.authz')}>
              <div className="mk-kv">
                <span>{t('audit.drawer.action')}</span>
                <span className="break-all">
                  {authzText ?? row.authz.action}{' '}
                  {authzText && (
                    <span className="mono au-perm text-[12px]">{row.authz.action}</span>
                  )}
                </span>
              </div>
              <div className="mk-kv">
                <span>{t('audit.drawer.outcome')}</span>
                <span className={row.authz.allowed ? 'au-allowed' : 'au-denied'}>
                  {t(row.authz.allowed ? 'audit.drawer.allowed' : 'audit.drawer.denied')}
                </span>
              </div>
              {row.authz.source && (
                <div className="mk-kv">
                  <span>{t('audit.drawer.event')}</span>
                  <span className="mono text-[12px] break-all">{refText(row.authz.source)}</span>
                </div>
              )}
              <div className="mk-meta mt-1">{t('audit.drawer.authzNote')}</div>
            </Sec>
          )}
          {keys.length > 0 && (
            <Sec title={t('audit.drawer.changes')}>
              <div className="au-chg">
                <div className="au-chg-h">
                  <span>{t('audit.drawer.field')}</span>
                  <span>{t('audit.drawer.before')}</span>
                  <span>{t('audit.drawer.after')}</span>
                </div>
                {keys.map((key) => (
                  <div key={key}>
                    <span className="mono break-all">{key}</span>
                    <span className="mono au-old">{fmt(row.before?.[key])}</span>
                    <span className="mono au-new">{fmt(row.after?.[key])}</span>
                  </div>
                ))}
              </div>
            </Sec>
          )}
          <div className="flex flex-wrap gap-2">
            {row.actor && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  onActor(row.actor);
                }}
              >
                <UserIcon size={12} />
                {t('audit.drawer.allOf', { name: actorName })}
              </button>
            )}
            {row.resource && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  if (row.resource && row.resourceKey) {
                    onResource({ key: row.resourceKey, id: row.resource });
                  }
                }}
              >
                <FilterIcon size={12} />
                {t('audit.drawer.history')}
              </button>
            )}
            {link && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  onLink(link.to);
                }}
              >
                {link.label}
                <ArrowRightIcon size={11} />
              </button>
            )}
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
