import type { TFunction } from 'i18next';

import type { OperationOutput } from '../../api/operations';
import { argumentEntries, ruleText } from '../approvals/model';
import { isRunReason } from '../schedules/model';

export type InboxPage = OperationOutput<'listInbox'>;
export type InboxItem = InboxPage['items'][number];

/**
 * Design tabs. «Menciones» has no backend: it is shown as «Próximamente». «Archivado» is not a tab
 * in the design: a button next to the unread count opens it.
 */
export type InboxTab = 'all' | 'unread' | 'approvals' | 'mentions';
export const TABS: readonly InboxTab[] = ['all', 'unread', 'approvals', 'mentions'];
export const SOON_TABS: ReadonlySet<InboxTab> = new Set<InboxTab>(['mentions']);
export type InboxView = Exclude<InboxTab, 'mentions'> | 'archived';
const VIEWS: readonly string[] = ['all', 'unread', 'approvals', 'archived'];

export function isInboxView(value: string): value is InboxView {
  return VIEWS.includes(value);
}

/** The design pages the notices («Mostrar más») in Todo, Sin leer and Archivado. */
export function isPagedView(view: InboxView): boolean {
  return view !== 'approvals';
}

/** Public ids of the API: a run notice or an approval request. Anything else is ignored. */
export const ITEM_ID = /^(?:[0-9]{13}[0-9a-f]{16}|[0-9a-f]{32})$/;
export const TASK_ID = /^[0-9a-f]{32}$/;
export const RUN_ID = /^[0-9a-f]{32}$/;

/** Key of an item in the list: kinds have different ids, but never trust that. */
export function keyOf(item: Pick<InboxItem, 'kind' | 'item_id'>): string {
  return `${item.kind}:${item.item_id}`;
}

/** Design: «Te piden aprobar: …» or «{tarea} · completada / no se completó». Plain text. */
export function titleOf(t: TFunction, item: InboxItem): string {
  if (item.approval) {
    return t('inbox.approvalTitle', {
      action: item.approval.description || item.approval.tool,
    });
  }
  if (item.run) {
    return t(item.run.ok ? 'inbox.runDone' : 'inbox.runFailed', { task: item.run.task_name });
  }
  return '';
}

/**
 * Design body: for an approval `tool · k=v, … · política` (as the chat card), for a run the first
 * line of the report or the reason (a fixed text per code, as Schedules). Always plain text.
 */
export function bodyOf(t: TFunction, item: InboxItem): string {
  if (item.approval) {
    const args = argumentEntries(item.approval)
      .map(([key, value]) => t('approvals.card.param', { key, value }))
      .join(', ');
    return [item.approval.tool, args, ruleText(t, item.approval)].filter(Boolean).join(' · ');
  }
  if (item.run) {
    if (item.run.ok) return item.run.summary ?? t('inbox.runNoText');
    const { reason } = item.run;
    return reason && isRunReason(reason)
      ? t(`schedules.run.reason.${reason}`)
      : t('schedules.run.unknownReason');
  }
  return '';
}

/**
 * Where «Ver resultado» / «Ver ejecución» goes: the task in Schedules, on that run's result when it
 * completed. Ids come from the API and are checked again before they become a route.
 */
export function runPath(item: InboxItem): string | null {
  const run = item.run;
  if (!run || !TASK_ID.test(run.task_id)) return null;
  if (run.ok && RUN_ID.test(run.run_id)) return `/schedules/${run.task_id}/run/${run.run_id}`;
  return `/schedules/${run.task_id}`;
}

export function matchesView(item: InboxItem, view: InboxView): boolean {
  if (view === 'archived') return item.archived;
  if (item.archived) return false;
  if (view === 'unread') return !item.read;
  if (view === 'approvals') return item.kind === 'approval';
  return true;
}
