import type { TFunction } from 'i18next';

import {
  isPermAction,
  outcomeKey,
  type AuditRow,
  type DetailText,
  type DirectoryRead,
} from './auditModel';
import { usd } from './govFormat';

// The words of an audit row, shared by Auditoría and the recent activity of Gobernanza (D89):
// both show the same events with the same texts (design round 19, `AUDIT_ACTIONS`).

function directoryReadText(t: TFunction, read: DirectoryRead): string {
  const { returned } = read;
  if (read.scope === 'people') {
    return [
      t(`audit.detail.directoryRead.${read.searched ? 'searched' : 'people'}`),
      ...(read.filter && read.filter !== 'all' ? [t(`people.filters.${read.filter}`)] : []),
      ...(returned === null ? [] : [t('audit.detail.directoryRead.results', { count: returned })]),
    ].join(' · ');
  }
  const text =
    returned === null
      ? t('audit.detail.directoryRead.changesUnknown')
      : t('audit.detail.directoryRead.changes', { count: returned });
  return read.missing > 0
    ? `${text} · ${t('audit.detail.directoryRead.missing', { count: read.missing })}`
    : text;
}

/**
 * Design round 20 `auditDetail`: «{agente} · v{n} · creado por {correo}» when approved and
 * «{agente} · v{n} · motivo: “{motivo}”» when retired; what is not known is left out.
 */
function agentText(t: TFunction, d: Extract<DetailText, { kind: 'agent' }>): string {
  return [
    d.name,
    ...(d.version === null ? [] : [t('audit.detail.agent.version', { version: d.version })]),
    ...(d.action === 'approve' && d.createdBy
      ? [t('audit.detail.agent.createdBy', { email: d.createdBy })]
      : []),
    ...(d.action === 'retire' && d.reason
      ? [t('audit.detail.agent.reason', { reason: d.reason })]
      : []),
  ].join(' · ');
}

/** The action's name in the design's words, or the raw event name when it has none. */
export function auditLabel(t: TFunction, row: AuditRow): string {
  return row.known ? t(`audit.actions.${row.known}`) : row.event;
}

/** The row's detail. `idpName` names the company SSO of a session event (from `config.json`). */
export function auditDetail(t: TFunction, row: AuditRow, idpName: string | null): string {
  const d = row.detail;
  const text =
    d.kind === 'defaults'
      ? t('audit.detail.defaults', {
          user: d.user ? usd(d.user) : '—',
          agent: d.agent ? usd(d.agent) : '—',
        })
      : d.kind === 'userDefault'
        ? t('audit.detail.userDefault')
        : d.kind === 'userOwn'
          ? t('audit.detail.userOwn', { amount: usd(d.amount) })
          : d.kind === 'propose'
            ? t('audit.detail.propose', { reason: d.reason })
            : d.kind === 'approve'
              ? d.version === null
                ? t('audit.detail.approveNoVersion')
                : t('audit.detail.approve', { version: d.version })
              : d.kind === 'reject'
                ? t('audit.detail.reject', { reason: d.reason })
                : d.kind === 'withdraw'
                  ? t('audit.detail.withdraw', { id: d.changeId })
                  : d.kind === 'access'
                    ? t(d.allowed ? 'audit.detail.accessView' : 'audit.detail.accessDenied', {
                        action: isPermAction(d.action) ? t(`audit.perms.${d.action}`) : d.action,
                      })
                    : d.kind === 'chat'
                      ? [
                          t('audit.detail.chat', { agent: d.agent, count: d.tools }),
                          ...(d.cost ? [t('audit.detail.chatCost', { amount: usd(d.cost) })] : []),
                        ].join(' · ')
                      : d.kind === 'catalogSync'
                        ? d.added > 0
                          ? t('audit.detail.catalogSync', { count: d.added })
                          : t('audit.detail.catalogSyncNone')
                        : d.kind === 'directoryRead'
                          ? directoryReadText(t, d.read)
                          : d.kind === 'agent'
                            ? agentText(t, d)
                            : d.kind === 'reportDownload'
                              ? t('audit.detail.reportDownload', {
                                  run: (d.run ?? '').slice(0, 8) || '—',
                                })
                              : d.kind === 'session'
                                ? d.sso
                                  ? // The name comes from `config.json`, shown as text.
                                    [
                                      t('audit.detail.session.startedSso'),
                                      ...(idpName ? [idpName] : []),
                                    ].join(' · ')
                                  : t(`audit.detail.${d.action}`)
                                : d.text;
  return text;
}

/** Design `auditOutcome`: what the API recorded about the write, plus its error code. */
export function auditOutcome(t: TFunction, row: AuditRow): string {
  const key = outcomeKey(row);
  return key ? `${t(`audit.outcome.${key}`)}${row.error ? ` · ${row.error}` : ''}` : '';
}
