import { useTranslation } from 'react-i18next';

import type { OperationOutput } from '../../api/operations';
import type { BadgeTone } from '../../components/Badge';

// Bucket proposals of knowledge bases in Aprobaciones and the Bandeja (design kb-source.jsx,
// D88 (48), (49)). What the API answers decides who sees and signs each one; nothing here does.

export type QueuedSource = OperationOutput<'sourceQueue'>['items'][number];
export type SourceStatus = QueuedSource['status'];

/** Design `KB_REQ_ST`: the badge of a proposal once it is not pending. */
export const SOURCE_TONE: Record<SourceStatus, BadgeTone> = {
  pending: 'amber',
  approved: 'green',
  rejected: 'red',
  withdrawn: 'neutral',
  removing: 'neutral',
};

/** ULIDs of the knowledge table: how a proposal is named in a route. */
export const SOURCE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function locationOf(source: Pick<QueuedSource, 'bucket' | 'prefix'>): string {
  return `s3://${source.bucket}/${source.prefix}`;
}

export function isPending(source: QueuedSource): boolean {
  return source.status === 'pending';
}

/** Design `KB.needsMe`: pending and the caller may sign it (never the proposer, D88 (20)). */
export function needsMe(source: QueuedSource): boolean {
  return source.status === 'pending' && source.can_decide;
}

/** The search of Aprobaciones: its id, its title (the knowledge base) and its bucket. */
export function matchesQuery(source: QueuedSource, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  return `${source.src_id} ${source.knowledge_base} ${locationOf(source)}`
    .toLowerCase()
    .includes(text);
}

/** When it left `pending`: decided, or withdrawn. */
export function closedAt(source: QueuedSource): string | null {
  return source.decided_at ?? source.withdrawn_at ?? null;
}

/** Design `KB.reqTitle`: «Leer un bucket en …» or, for a change, «Cambiar el bucket de …». */
export function useSourceTitle() {
  const { t } = useTranslation();
  return (source: QueuedSource) =>
    source.replaces
      ? t('approvals.sources.titleChange', { kb: source.knowledge_base })
      : t('approvals.sources.titleNew', { kb: source.knowledge_base });
}

/** An internal route to the knowledge base, built from an id the API sent. */
export function knowledgePath(source: QueuedSource): string {
  return `/knowledge/${encodeURIComponent(source.kb_id)}`;
}
