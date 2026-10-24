import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../auth/useSession';
import { Locked } from './KbDocuments';
import {
  SEARCH_MAX_LENGTH,
  formatScore,
  shownStatus,
  type Fragment,
  type KnowledgeBase,
} from './model';

/**
 * «Probar búsqueda» (design `KbTestTab`, D88 (37)): the search an agent would make, with the
 * person's identity. The fragments are untrusted content of the documents: they are shown as plain
 * text, never as Markdown or HTML.
 */
export function SearchTab({
  kb,
  messageOf,
}: {
  kb: KnowledgeBase;
  messageOf: (error: unknown) => string;
}) {
  const { t } = useTranslation();
  const { api, me } = useSession();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly Fragment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = kb.groups.join(', ');
  const owner = kb.owner.user_id === me.user_id;

  if (!kb.can_view_documents) {
    return (
      <Locked title={t('knowledge.test.lockedDocsTitle')}>
        {t('knowledge.test.lockedDocs', { groups })}
      </Locked>
    );
  }
  if (!kb.can_search) {
    const why =
      owner && me.is_admin
        ? t('knowledge.test.ownerAndAdmin')
        : owner
          ? t('knowledge.test.owner')
          : me.is_admin
            ? t('knowledge.test.admin')
            : '';
    return (
      <Locked title={t('knowledge.test.lockedGroupsTitle')}>
        {t('knowledge.test.lockedGroups', { groups })} {why} {t('knowledge.test.docsTab')}
      </Locked>
    );
  }
  const status = shownStatus(kb);
  if (status === 'deleting') return <div className="mk-meta">{t('knowledge.test.deleting')}</div>;
  if (!kb.documents) {
    return (
      <div className="mk-meta">
        {status === 'approval'
          ? t('knowledge.test.noneApproval')
          : kb.origin === 'upload'
            ? t('knowledge.test.noneUpload')
            : t('knowledge.test.none')}
      </div>
    );
  }

  const run = async () => {
    const text = query.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await api.call('search', {
        path: { kb_id: kb.kb_id },
        body: { query: text },
      });
      setResults(answer.fragments);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mk-meta leading-normal">{t('knowledge.test.help')}</div>
      <div className="flex items-center gap-2">
        <input
          className="input min-w-0 flex-1"
          value={query}
          maxLength={SEARCH_MAX_LENGTH}
          placeholder={t('knowledge.test.placeholder')}
          aria-label={t('knowledge.test.label')}
          onChange={(event) => {
            setQuery(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void run();
          }}
        />
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!query.trim() || busy}
          onClick={() => {
            void run();
          }}
        >
          {busy ? t('knowledge.test.searching') : t('knowledge.test.search')}
        </button>
      </div>
      {error ? (
        <div className="kb-err" role="alert">
          {error}
        </div>
      ) : null}
      {results === null ? null : results.length ? (
        <div className="kb-hits" aria-live="polite">
          {results.map((fragment, index) => (
            <div key={`${fragment.doc_id}-${String(index)}`} className="kb-hit">
              <div className="flex items-baseline justify-between gap-2">
                <span className="kb-doc-n min-w-0">
                  {fragment.document ?? t('knowledge.test.document')}
                  {fragment.page ? (
                    <span className="mk-meta font-sans">
                      {t('knowledge.test.page', { page: fragment.page })}
                    </span>
                  ) : null}
                </span>
                {fragment.score !== null ? (
                  <span className="mono mk-meta" title={t('knowledge.test.score')}>
                    {formatScore(fragment.score)}
                  </span>
                ) : null}
              </div>
              <p className="kb-hit-t">{fragment.text}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="mk-meta">{t('knowledge.test.noResults')}</div>
      )}
    </>
  );
}
