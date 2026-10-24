import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adminErrorKey, apiErrorCode, isStaleDataError } from '../../api/adminErrors';
import { useSession } from '../../auth/useSession';
import {
  BookOpenIcon,
  DocumentIcon,
  RefreshIcon,
  TrashIcon,
  WarnIcon,
} from '../../components/icons';
import { SidePanel } from '../../components/SidePanel';
import { SoonTag } from '../../components/Soon';
import { Tabs } from '../../components/Tabs';
import { formatRelative } from '../../lib/format';
import {
  activeSources,
  formatBytes,
  formatCount,
  formatEstimate,
  hasSecret,
  isErrorKey,
  locationError,
  partialAgents,
  sameGroups,
  shownLocation,
  shownStatus,
  type Document,
  type KnowledgeBase,
  type Schedule,
  type Source,
} from './model';
import { DocumentsTab, type Guard } from './KbDocuments';
import { SearchTab } from './KbSearch';
import { GroupChips, Kv, Notice, ScheduleChips, Section, StatusBadge } from './parts';

export type Tab = 'info' | 'docs' | 'test' | 'access';
/** Documents are read again this often while some of them are in progress. */
const DOCS_POLL_MS = 5000;
type Notify = (message: string, tone?: 'success' | 'info') => void;

const PANEL_ID = 'kb-panel';
/** Errors of the API with a text of their own in this panel. */
const OWN_ERRORS = new Set([
  'mango_bucket',
  'bucket_not_in_account',
  'bucket_not_found',
  'bucket_key_unsupported',
  'source_check_unavailable',
  'source_pending',
  'source_exists',
  'group_unknown',
  'knowledge_base_in_use',
  'knowledge_base_deleting',
  'sync_unavailable',
  'search_busy',
  'search_unavailable',
  'knowledge_base_full',
  'type_not_supported',
  'type_mismatch',
  'document_deleting',
]);

interface Props {
  kb: KnowledgeBase;
  groups: readonly string[] | null;
  notify: Notify;
  /** The knowledge base as the API answered an action. */
  onChanged: (kb: KnowledgeBase) => void;
  /** Reads the list again (after an action on its sources). */
  onReload: () => Promise<void>;
  onClose: () => void;
  /**
   * Where the panel opens: a new knowledge base of files opens on its upload; one of a bucket
   * whose proposal could not be sent opens on «Acceso y sync», saying so, with what was typed.
   */
  start?: { tab: Tab; uploading: boolean; notice?: string; location?: string } | undefined;
}

function who(source: Source['proposed_by'] | null | undefined): string | null {
  return source ? (source.email ?? source.user_id) : null;
}

/**
 * The panel of one knowledge base (design `KbDetail`): «Resumen» and «Acceso» («Acceso y sync»
 * for a bucket). Its sources are read here, for who proposed and who decided; reading them is
 * authorized by the API like everything else.
 */
export function KbDetail({ kb, groups, notify, onChanged, onReload, onClose, start }: Props) {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const [tab, setTab] = useState<Tab>(start?.tab ?? 'info');
  const [uploading, setUploading] = useState(start?.uploading ?? false);
  const [documents, setDocuments] = useState<readonly Document[] | null>(null);
  const [documentsFailed, setDocumentsFailed] = useState(false);
  const [documentsToken, setDocumentsToken] = useState(0);
  const guardRef: Guard = useRef(null);
  const [sources, setSources] = useState<readonly Source[] | null>(null);
  const [sourcesToken, setSourcesToken] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const bucket = kb.origin === 'bucket';
  const status = shownStatus(kb);
  const deleting = status === 'deleting';
  const mine = kb.owner.user_id === me.user_id;
  // The sources are read again when the list says they changed, not on every poll.
  const sourcesKey = JSON.stringify(kb.sources);

  useEffect(() => {
    if (!bucket) return;
    const controller = new AbortController();
    api.call('listSources', { path: { kb_id: kb.kb_id } }, { signal: controller.signal }).then(
      (data) => {
        setSources(data.items);
      },
      () => {
        if (!controller.signal.aborted) setSources(null);
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, bucket, kb.kb_id, sourcesKey, sourcesToken]);

  // The documents, for whoever sees them: their tab and the count of those not indexed.
  const docsKey = `${kb.status}:${String(kb.sync_running)}:${String(kb.documents)}`;
  useEffect(() => {
    if (!kb.can_view_documents) return;
    const controller = new AbortController();
    api.call('listDocuments', { path: { kb_id: kb.kb_id } }, { signal: controller.signal }).then(
      (data) => {
        setDocuments(data.items);
        setDocumentsFailed(false);
      },
      () => {
        if (!controller.signal.aborted) setDocumentsFailed(true);
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, kb.can_view_documents, kb.kb_id, docsKey, documentsToken]);

  const documentsBusy = (documents ?? []).some(
    (document) => document.status !== 'indexed' && document.status !== 'failed',
  );
  useEffect(() => {
    if (!documentsBusy) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      setDocumentsToken((value) => value + 1);
    }, DOCS_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [documentsBusy]);

  /** Leaving the upload with files not saved asks first (design `guard`). */
  const ask = (proceed: () => void) => {
    if (guardRef.current && !guardRef.current(proceed)) return;
    proceed();
  };
  const close = () => {
    ask(onClose);
  };
  const goTab = (next: Tab, upload = false) => {
    ask(() => {
      setTab(next);
      setUploading(upload);
    });
  };

  const messageOf = (error: unknown) => {
    const code = apiErrorCode(error);
    return isErrorKey(code, OWN_ERRORS) ? t(`knowledge.errors.${code}`) : t(adminErrorKey(error));
  };

  const refresh = async () => {
    await onReload();
    setSourcesToken((value) => value + 1);
  };

  const syncNow = async () => {
    setSyncError(null);
    setSyncing(true);
    try {
      const { sync } = await api.call('synchronizeKnowledgeBase', {
        path: { kb_id: kb.kb_id },
        body: {},
      });
      if (sync === 'queued') setSyncError(t('knowledge.detail.syncBusy'));
      else notify(t('knowledge.toast.syncing', { name: kb.name }), 'info');
      await onReload();
    } catch (error) {
      setSyncError(messageOf(error));
    } finally {
      setSyncing(false);
    }
  };

  const noSync = ['syncing', 'approval', 'rejected', 'nosource'].includes(status);
  const failed = (documents ?? []).filter((document) => document.status === 'failed').length;
  const tabs = [
    { id: 'info' as const, label: t('knowledge.detail.tabs.info') },
    {
      id: 'docs' as const,
      label:
        kb.can_view_documents && failed
          ? t('knowledge.detail.tabs.docsFailed', { count: failed })
          : t('knowledge.detail.tabs.docs'),
    },
    { id: 'test' as const, label: t('knowledge.detail.tabs.test') },
    {
      id: 'access' as const,
      label: bucket ? t('knowledge.detail.tabs.accessBucket') : t('knowledge.detail.tabs.access'),
    },
  ];
  const origin = bucket ? t('knowledge.detail.originBucket') : t('knowledge.detail.originUpload');

  return (
    <SidePanel
      title={kb.name}
      width={580}
      lead={
        <span className="mc-ic lg">
          <BookOpenIcon size={20} />
        </span>
      }
      meta={
        <>
          <StatusBadge kb={kb} />
          <span className="mk-meta">
            {t(mine ? 'knowledge.detail.metaMine' : 'knowledge.detail.meta', {
              origin,
              owner: kb.owner.name ?? kb.owner.email ?? kb.owner.user_id,
            })}
          </span>
        </>
      }
      tabs={
        <Tabs
          className="tk-tabs kb-tabs"
          label={t('knowledge.detail.tabsLabel')}
          idPrefix="kb"
          panelId={PANEL_ID}
          active={tab}
          onChange={(next) => {
            goTab(next);
          }}
          tabs={tabs}
        />
      }
      footer={
        kb.can_edit && !deleting && bucket ? (
          <>
            <div className="flex items-center flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-sm"
                disabled={noSync || syncing}
                onClick={() => {
                  void syncNow();
                }}
              >
                <RefreshIcon size={12} />
                {status === 'syncing'
                  ? t('knowledge.detail.syncing')
                  : t('knowledge.detail.syncNow')}
              </button>
              {status === 'approval' ? (
                <span className="mk-meta">{t('knowledge.detail.syncWhenApproved')}</span>
              ) : null}
              {status === 'rejected' || status === 'nosource' ? (
                <span className="mk-meta">{t('knowledge.detail.proposeHint')}</span>
              ) : null}
            </div>
            {syncError ? (
              <div className="kb-err mt-2" role="alert">
                {syncError}
              </div>
            ) : null}
          </>
        ) : kb.can_edit && !deleting && !(tab === 'docs' && uploading) ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              goTab('docs', true);
            }}
          >
            <DocumentIcon size={12} />
            {t('knowledge.detail.uploadFiles')}
          </button>
        ) : null
      }
      onClose={close}
      onEscape={close}
    >
      <div
        id={PANEL_ID}
        role="tabpanel"
        aria-labelledby={`kb-${tab}`}
        className="flex flex-col gap-[18px]"
      >
        {tab === 'info' ? (
          <Summary
            kb={kb}
            sources={sources}
            documents={documents}
            failed={documents === null ? null : failed}
            onAccess={() => {
              goTab('access');
            }}
            onDocuments={() => {
              goTab('docs');
            }}
            onUpload={() => {
              goTab('docs', true);
            }}
          />
        ) : tab === 'docs' ? (
          <DocumentsTab
            kb={kb}
            documents={documents}
            documentsFailed={documentsFailed}
            uploading={uploading}
            setUploading={setUploading}
            guardRef={guardRef}
            notify={notify}
            messageOf={messageOf}
            onRetry={() => {
              setDocumentsToken((value) => value + 1);
            }}
            onChanged={async () => {
              setDocumentsToken((value) => value + 1);
              await onReload();
            }}
          />
        ) : tab === 'test' ? (
          <SearchTab kb={kb} messageOf={messageOf} />
        ) : (
          <Access
            kb={kb}
            sources={sources}
            groups={groups}
            notice={start?.notice}
            initialLocation={start?.location}
            notify={notify}
            messageOf={messageOf}
            onChanged={onChanged}
            onRefresh={refresh}
          />
        )}
      </div>
    </SidePanel>
  );
}

function Summary({
  kb,
  sources,
  documents,
  failed,
  onAccess,
  onDocuments,
  onUpload,
}: {
  kb: KnowledgeBase;
  sources: readonly Source[] | null;
  documents: readonly Document[] | null;
  /** Documents not indexed; null when the documents were not read. */
  failed: number | null;
  onAccess: () => void;
  onDocuments: () => void;
  onUpload: () => void;
}) {
  const { t } = useTranslation();
  const { me } = useSession();
  const status = shownStatus(kb);
  const bucket = kb.origin === 'bucket';
  const location = shownLocation(kb);
  const partial = partialAgents(kb);
  const partialIds = new Set(partial.map((agent) => agent.agent_id));
  const agents = kb.agents;
  const pending = sources?.find((source) => source.status === 'pending') ?? null;
  const decided = sources?.find((source) => source.status === 'rejected') ?? null;
  const loc = location ?? '';
  const stillUsing = kb.documents
    ? kb.last_synced_at
      ? t('knowledge.summary.stillUsing', { ago: formatRelative(kb.last_synced_at) })
      : ''
    : t('knowledge.summary.nothingIndexed');
  const estimate = kb.budget_estimate_usd ? formatEstimate(kb.budget_estimate_usd) : null;
  const preparing = status === 'syncing' && kb.sync_preparing;
  const busy = (documents ?? []).filter(
    (document) => document.status !== 'indexed' && document.status !== 'failed',
  ).length;
  const indexed = (documents ?? []).filter((document) => document.status === 'indexed').length;

  return (
    <>
      {kb.description ? <p className="m-0 text-sm leading-[1.55]">{kb.description}</p> : null}
      {status === 'deleting' ? (
        <Notice tone="busy">
          <b>{t('knowledge.summary.deletingLead')}</b> {t('knowledge.summary.deleting')}
        </Notice>
      ) : null}
      {preparing ? <Notice tone="busy">{t('knowledge.summary.preparing')}</Notice> : null}
      {status === 'syncing' && !preparing ? (
        <Notice tone="busy">
          {bucket ? (
            location ? (
              <span className="[overflow-wrap:anywhere]">
                {t('knowledge.summary.syncingBucket', { location })}
              </span>
            ) : (
              t('knowledge.summary.syncingBucketNoLocation')
            )
          ) : (
            t('knowledge.summary.syncingUpload')
          )}
        </Notice>
      ) : null}
      {status === 'warn' && failed ? (
        <Notice tone="amber">
          {t('knowledge.summary.warnCount', { count: failed })}{' '}
          <button type="button" className="sr-link" onClick={onDocuments}>
            {t('knowledge.summary.warnSeeWhich')}
          </button>
        </Notice>
      ) : null}
      {status === 'warn' && !kb.can_view_documents ? (
        <Notice tone="amber">{t('knowledge.summary.warnHidden')}</Notice>
      ) : null}
      {status === 'error' ? (
        <Notice tone="red">
          {t('knowledge.summary.error')} {stillUsing}
          {kb.can_edit ? ` ${t('knowledge.summary.errorAction')}` : ''}
        </Notice>
      ) : null}
      {status === 'blocked' ? (
        <Notice tone="amber">
          <BudgetText kb={kb} estimate={estimate} /> {stillUsing}
          {kb.can_edit ? ` ${t('knowledge.summary.budgetAction')}` : ''}
        </Notice>
      ) : null}
      {status === 'full' ? (
        <Notice tone="amber">
          {t('knowledge.summary.full')}
          {kb.can_edit ? ` ${t('knowledge.summary.fullAction')}` : ''}
        </Notice>
      ) : null}
      {status === 'pending' ? (
        <Notice tone="info">
          {bucket ? t('knowledge.summary.neverSynced') : t('knowledge.summary.noDocuments')}
          {!bucket && kb.can_edit ? (
            <>
              {' '}
              <button type="button" className="sr-link" onClick={onUpload}>
                {t('knowledge.detail.uploadFiles')}
              </button>
            </>
          ) : null}
        </Notice>
      ) : null}
      {status === 'approval' ? (
        <Notice tone="clock">
          <b>{t('knowledge.summary.approvalLead')}</b>{' '}
          <span className="[overflow-wrap:anywhere]">
            {pending?.proposed_by.user_id === me.user_id
              ? t('knowledge.summary.approvalMine', { location: loc })
              : who(pending?.proposed_by)
                ? t('knowledge.summary.approvalOther', {
                    who: who(pending?.proposed_by),
                    location: loc,
                  })
                : t('knowledge.summary.approvalSomeone', { location: loc })}
          </span>{' '}
          {t('knowledge.summary.approvalTail')}
        </Notice>
      ) : null}
      {status === 'rejected' ? (
        <Notice tone="red">
          <b>{t('knowledge.summary.rejectedLead')}</b>{' '}
          <span className="[overflow-wrap:anywhere]">
            {t(decided?.note ? 'knowledge.summary.rejectedNote' : 'knowledge.summary.rejected', {
              who: who(decided?.decided_by) ?? t('knowledge.summary.rejectedSomeone'),
              location: loc,
              note: decided?.note ?? '',
            })}
          </span>{' '}
          {kb.can_edit ? (
            <button type="button" className="sr-link" onClick={onAccess}>
              {t('knowledge.summary.proposeOther')}
            </button>
          ) : null}
        </Notice>
      ) : null}
      {status === 'nosource' ? (
        <Notice tone="info">
          <b>{t('knowledge.summary.nosourceLead')}</b>{' '}
          {kb.sources?.length === 0
            ? t('knowledge.summary.nosourceNotSent')
            : kb.sources?.some((source) => source.status === 'withdrawn')
              ? t('knowledge.summary.nosource')
              : t('knowledge.summary.nosourceNone')}{' '}
          {kb.can_edit ? (
            <button type="button" className="sr-link" onClick={onAccess}>
              {t('knowledge.summary.proposeBucket')}
            </button>
          ) : null}
        </Notice>
      ) : null}
      {partial.length > 0 ? (
        <Notice tone="amber">
          <b>{t('knowledge.summary.partialLead')}</b> {t('knowledge.summary.partial')}
          <div className="kb-gaps">
            {partial.map((agent) => (
              <div key={agent.agent_id}>
                <span>{agent.name}</span>
                <span className="mono">{(agent.groups_without_access ?? []).join(', ')}</span>
              </div>
            ))}
          </div>
          {t('knowledge.summary.partialTail')}
        </Notice>
      ) : null}
      <Section title={t('knowledge.summary.content')}>
        <Kv label={t('knowledge.summary.documents')}>
          <span className="mono">
            {kb.can_view_documents && documents !== null ? (
              <>
                {formatCount(indexed)}
                {failed ? t('knowledge.summary.documentsFailed', { count: failed }) : ''}
                {busy ? t('knowledge.summary.documentsBusy', { count: busy }) : ''}
              </>
            ) : (
              formatCount(kb.documents)
            )}
          </span>
        </Kv>
        <Kv label={t('knowledge.summary.size')}>
          <span className="mono">{kb.documents ? formatBytes(kb.bytes) : '—'}</span>
        </Kv>
        <Kv label={t('knowledge.summary.limits')}>
          <span>
            {t('knowledge.summary.limitsValue', {
              documents: formatCount(kb.documents),
              bytes: formatBytes(kb.bytes),
            })}
          </span>
        </Kv>
        <Kv label={t('knowledge.summary.embeddings')}>
          <span>{t('knowledge.summary.embeddingsValue')}</span>
        </Kv>
      </Section>
      <Section title={t('knowledge.summary.source')}>
        <Kv label={t('knowledge.summary.origin')}>
          <span>
            {bucket ? t('knowledge.summary.originBucket') : t('knowledge.summary.originUpload')}
          </span>
        </Kv>
        {bucket && location ? (
          <Kv label={t('knowledge.summary.bucket')}>
            <span className="mono text-xs">{location}</span>
          </Kv>
        ) : null}
        {bucket ? (
          <Kv label={t('knowledge.summary.lastSync')}>
            <span>
              {kb.last_synced_at ? formatRelative(kb.last_synced_at) : t('knowledge.summary.never')}
            </span>
          </Kv>
        ) : null}
        {bucket && kb.last_attempt_at && kb.last_attempt_at !== kb.last_synced_at ? (
          <Kv label={t('knowledge.summary.lastTry')}>
            <span>{formatRelative(kb.last_attempt_at)}</span>
          </Kv>
        ) : null}
        {bucket ? (
          <Kv label={t('knowledge.summary.frequency')}>
            <span>{t(`knowledge.freqs.${kb.sync_schedule}`)}</span>
          </Kv>
        ) : (
          <Kv label={t('knowledge.summary.indexing')}>
            <span>
              {kb.last_synced_at
                ? t('knowledge.summary.indexingLast', { ago: formatRelative(kb.last_synced_at) })
                : t('knowledge.summary.indexingValue')}
            </span>
          </Kv>
        )}
      </Section>
      <Section title={t('knowledge.summary.agents', { count: agents?.length ?? 0 })}>
        {agents === null ? (
          <div className="mk-meta">{t('knowledge.summary.agentsUnknown')}</div>
        ) : agents.length ? (
          agents.map((agent) => (
            <div key={agent.agent_id} className="mk-line flex items-center justify-between">
              <span>{agent.name}</span>
              <span className="mk-meta">
                {partialIds.has(agent.agent_id) ? t('knowledge.summary.agentGap') : ''}
              </span>
            </div>
          ))
        ) : (
          <div className="mk-meta">{t('knowledge.summary.agentsNone')}</div>
        )}
        {(agents?.length ?? 0) > 0 && !kb.documents ? (
          <div className="mk-meta mt-1">{t('knowledge.summary.agentsWithoutContent')}</div>
        ) : null}
      </Section>
      <Section title={t('knowledge.summary.usage')}>
        <Kv label={t('knowledge.summary.queries')}>
          <span>
            <SoonTag />
          </span>
        </Kv>
      </Section>
    </>
  );
}

/**
 * «No empezó por presupuesto» naming whose budget it was (D88 (53)): yours, or the one of who
 * asked; a scheduled one says so. Without the person (a record from before) it names none.
 */
function BudgetText({ kb, estimate }: { kb: KnowledgeBase; estimate: string | null }) {
  const { t } = useTranslation();
  const { me } = useSession();
  const by = kb.budget_by;
  const owner = by && by.user_id === kb.owner.user_id ? (kb.owner.name ?? kb.owner.email) : null;
  const name = by ? (by.email ?? owner) : null;
  const whose = !by
    ? t('knowledge.summary.whoseUnknown')
    : by.user_id === me.user_id
      ? t('knowledge.summary.whoseMine')
      : name
        ? t('knowledge.summary.whoseOf', { who: name })
        : t('knowledge.summary.whoseUnknown');
  const lead = by?.scheduled
    ? t('knowledge.summary.budgetLeadScheduled')
    : t('knowledge.summary.budgetLead');
  return (
    <>
      {estimate
        ? t('knowledge.summary.budget', { lead, usd: estimate, whose })
        : t('knowledge.summary.budgetNoEstimate', { lead, whose })}
    </>
  );
}

function Access({
  kb,
  sources,
  groups,
  notice,
  initialLocation,
  notify,
  messageOf,
  onChanged,
  onRefresh,
}: {
  kb: KnowledgeBase;
  sources: readonly Source[] | null;
  groups: readonly string[] | null;
  /** Why the panel opened here: the proposal of the bucket was not sent when it was created. */
  notice?: string | undefined;
  initialLocation?: string | undefined;
  notify: Notify;
  messageOf: (error: unknown) => string;
  onChanged: (kb: KnowledgeBase) => void;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const bucket = kb.origin === 'bucket';
  const status = shownStatus(kb);
  const edit = kb.can_edit && status !== 'deleting';
  const [chosen, setChosen] = useState<readonly string[]>(kb.groups);
  const [schedule, setSchedule] = useState<Schedule>(kb.sync_schedule);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const reopen = Boolean(notice) && status === 'nosource';
  const [editing, setEditing] = useState(reopen);
  const [location, setLocation] = useState(reopen ? (initialLocation ?? '') : '');
  const [refError, setRefError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { approved } = activeSources(kb);
  const pending = sources?.find((source) => source.status === 'pending') ?? null;
  const lastDecided = sources?.find((s) => s.status === 'rejected') ?? null;
  const approvedFull = sources?.find((source) => source.status === 'approved') ?? null;
  const shown = shownLocation(kb);
  const dirty = !sameGroups(chosen, kb.groups) || (bucket && schedule !== kb.sync_schedule);
  const mineIn = chosen.some((group) => me.groups.includes(group));
  const using = kb.agents ?? [];
  const canPropose = edit && bucket && !pending && status !== 'approval';

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.call('updateExistingKnowledgeBase', {
        path: { kb_id: kb.kb_id },
        body: {
          version: kb.version,
          name: kb.name,
          description: kb.description,
          groups: [...chosen],
          ...(bucket ? { sync_schedule: schedule } : {}),
        },
      });
      onChanged(updated);
      notify(t('knowledge.toast.saved'), 'success');
    } catch (error) {
      if (isStaleDataError(error)) await onRefresh().catch(() => undefined);
      setSaveError(messageOf(error));
    } finally {
      setSaving(false);
    }
  };

  const propose = async () => {
    const value = location.trim();
    const shape = locationError(value);
    // The same bucket of now is refused by the API (`source_exists`), with its own text.
    const error = shape
      ? t(`knowledge.errors.${shape}`)
      : hasSecret(value)
        ? t('knowledge.errors.secretRef')
        : null;
    if (error) {
      setRefError(error);
      return;
    }
    setSending(true);
    try {
      await api.call('propose', { path: { kb_id: kb.kb_id }, body: { location: value } });
      setEditing(false);
      setLocation('');
      notify(t('knowledge.toast.proposed'), 'success');
      await onRefresh();
    } catch (failure) {
      setRefError(messageOf(failure));
    } finally {
      setSending(false);
    }
  };

  const withdraw = async (source: Source) => {
    setBusy(true);
    try {
      await api.call('deleteSource', {
        path: { kb_id: kb.kb_id, src_id: source.src_id },
        body: { version: source.version },
      });
      notify(t('knowledge.toast.withdrawn'), 'info');
      await onRefresh();
    } catch (error) {
      setRefError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setDeleteError(null);
    try {
      const deleted = await api.call('deleteExistingKnowledgeBase', {
        path: { kb_id: kb.kb_id },
        body: { version: kb.version },
      });
      setConfirming(false);
      onChanged(deleted);
      notify(t('knowledge.toast.deleting', { name: kb.name }), 'info');
    } catch (error) {
      if (isStaleDataError(error)) await onRefresh().catch(() => undefined);
      setDeleteError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const bucketLabel =
    status === 'approval'
      ? t('knowledge.access.proposed')
      : status === 'rejected'
        ? t('knowledge.access.rejected')
        : status === 'nosource'
          ? kb.sources?.length === 0
            ? t('knowledge.access.notSent')
            : t('knowledge.access.withdrawn')
          : t('knowledge.access.readsFrom');
  const changeRejected =
    !pending && approved && lastDecided?.decided_at && approvedFull?.decided_at
      ? lastDecided.decided_at > approvedFull.decided_at
      : false;

  return (
    <>
      {reopen ? (
        <div className="mc-alert amber" role="alert">
          <WarnIcon size={14} />
          <div>{notice}</div>
        </div>
      ) : null}
      <Section title={t('knowledge.access.groups')}>
        <GroupChips options={groups ?? []} value={chosen} onChange={setChosen} disabled={!edit} />
        {edit && chosen.length > 0 && !mineIn ? (
          <Notice tone="amber" className="mt-2">
            {t('knowledge.access.notInGroups')}
          </Notice>
        ) : null}
        <div className="mk-meta mt-1.5 leading-normal">{t('knowledge.access.groupsHelp')}</div>
      </Section>
      {bucket ? (
        <Section title={t('knowledge.access.bucket')}>
          {shown ? (
            <Kv label={bucketLabel}>
              <span className="mono text-xs">{shown}</span>
            </Kv>
          ) : null}
          {approved && approvedFull?.decided_at ? (
            <Kv label={t('knowledge.access.approvedBy')}>
              <span>
                {t('knowledge.access.approvedByValue', {
                  who: who(approvedFull.decided_by) ?? '—',
                  ago: formatRelative(approvedFull.decided_at),
                })}
              </span>
            </Kv>
          ) : null}
          {pending ? (
            <Notice tone="clock" className="mt-1.5">
              {approved ? (
                <span className="[overflow-wrap:anywhere]">
                  {t('knowledge.access.changePending', {
                    location: `s3://${pending.bucket}/${pending.prefix}`,
                  })}
                </span>
              ) : (
                t('knowledge.access.waiting')
              )}
              {pending.proposed_by.user_id === me.user_id ? (
                <div className="mt-2">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => {
                      void withdraw(pending);
                    }}
                  >
                    {t('knowledge.access.withdraw')}
                  </button>
                </div>
              ) : null}
            </Notice>
          ) : null}
          {changeRejected && lastDecided ? (
            <div className="mk-meta [overflow-wrap:anywhere]">
              {t(
                lastDecided.note
                  ? 'knowledge.access.changeRejectedNote'
                  : 'knowledge.access.changeRejected',
                {
                  location: `s3://${lastDecided.bucket}/${lastDecided.prefix}`,
                  note: lastDecided.note ?? '',
                },
              )}
            </div>
          ) : null}
          {canPropose && !editing ? (
            <button
              type="button"
              className="btn btn-sm mt-1.5 self-start"
              onClick={() => {
                setEditing(true);
                setLocation(approved?.location ?? (status === 'nosource' ? (shown ?? '') : ''));
                setRefError(null);
              }}
            >
              {approved
                ? t('knowledge.access.change')
                : status === 'nosource'
                  ? t('knowledge.access.proposeBucket')
                  : t('knowledge.access.proposeOther')}
            </button>
          ) : null}
          {editing ? (
            <div className="kb-ref-form">
              <label htmlFor="kb-ref" className="text-[12.5px] font-medium">
                {t('knowledge.access.refLabel')}
              </label>
              <input
                id="kb-ref"
                className="input mono"
                value={location}
                maxLength={600}
                placeholder={t('knowledge.access.refPlaceholder')}
                aria-invalid={Boolean(refError)}
                autoFocus
                onChange={(event) => {
                  setLocation(event.target.value);
                  setRefError(null);
                }}
              />
              {refError ? (
                <div className="kb-err" role="alert">
                  {refError}
                </div>
              ) : null}
              <div className="mk-meta leading-normal">
                {t('knowledge.access.refHelp')}
                {approved ? t('knowledge.access.refHelpChange') : ''}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={sending || !location.trim()}
                  onClick={() => {
                    void propose();
                  }}
                >
                  {sending ? t('knowledge.access.sending') : t('knowledge.access.send')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setEditing(false);
                  }}
                >
                  {t('knowledge.access.cancel')}
                </button>
              </div>
            </div>
          ) : refError ? (
            <div className="kb-err" role="alert">
              {refError}
            </div>
          ) : null}
          <div className="mk-meta mt-1.5 leading-normal">{t('knowledge.access.bucketHelp')}</div>
        </Section>
      ) : null}
      {bucket ? (
        <Section title={t('knowledge.access.sync')}>
          <ScheduleChips value={schedule} onChange={setSchedule} disabled={!edit} />
          <div className="mk-meta mt-1.5">{t('knowledge.access.syncHelp')}</div>
        </Section>
      ) : (
        <Section title={t('knowledge.access.indexing')}>
          <div className="mk-meta leading-normal">{t('knowledge.access.indexingHelp')}</div>
        </Section>
      )}
      {edit ? (
        <div className="flex items-center flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!dirty || chosen.length === 0 || saving}
            onClick={() => {
              void save();
            }}
          >
            {saving ? t('knowledge.access.saving') : t('knowledge.access.save')}
          </button>
          {chosen.length === 0 ? (
            <span className="text-xs text-[var(--red)]">{t('knowledge.access.pickGroup')}</span>
          ) : null}
          {saveError ? (
            <div className="kb-err w-full" role="alert">
              {saveError}
            </div>
          ) : null}
        </div>
      ) : null}
      {edit ? (
        <div className="kb-danger">
          <div className="mk-sec-t">{t('knowledge.access.delete')}</div>
          <div className="mk-meta leading-normal">
            {using.length
              ? t('knowledge.access.inUse', {
                  count: using.length,
                  names: using.map((agent) => agent.name).join(', '),
                })
              : bucket
                ? t('knowledge.access.deleteHelpBucket')
                : t('knowledge.access.deleteHelp')}
          </div>
          {!confirming ? (
            <button
              type="button"
              className="btn btn-sm mk-danger"
              disabled={using.length > 0}
              onClick={() => {
                setConfirming(true);
              }}
            >
              <TrashIcon size={12} />
              {t('knowledge.access.deleteButton')}
            </button>
          ) : (
            <div className="kb-confirm">
              <span>{t('knowledge.access.confirmDelete', { name: kb.name })}</span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-sm mk-danger"
                  disabled={busy}
                  onClick={() => {
                    void remove();
                  }}
                >
                  {t('knowledge.access.confirm')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  {t('knowledge.access.cancel')}
                </button>
              </span>
            </div>
          )}
          {deleteError ? (
            <div className="kb-err" role="alert">
              {deleteError}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
