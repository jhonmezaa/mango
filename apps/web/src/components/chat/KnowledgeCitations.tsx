import { useTranslation } from 'react-i18next';

import type { Citation, KnowledgeSearch } from '../../hooks/chatState';
import { BookOpenIcon } from '../icons';

/**
 * «Buscó en {kb} · {n} fragmentos» (design `KbStep`, D88 (44)): one line per knowledge search
 * of the turn. Names come from the registry through the API, as plain text.
 */
export function KnowledgeSteps({ searches }: { searches: readonly KnowledgeSearch[] }) {
  const { t } = useTranslation();
  if (!searches.length) return null;
  return (
    <div className="kb-steps">
      {searches.map((search, index) => {
        // Without fragments it does not name a knowledge base: none is known (design).
        const none = search.count === 0;
        return (
          <span key={index} className={none ? 'kb-step is-empty' : 'kb-step'}>
            <BookOpenIcon size={11} />
            {t('chat.knowledge.searched')}{' '}
            {none || !search.knowledgeBases.length ? (
              t('chat.knowledge.anyBase')
            ) : (
              <b>{search.knowledgeBases.join(', ')}</b>
            )}
            {' · '}
            {none
              ? t('chat.knowledge.noFragments')
              : t('chat.knowledge.fragments', { count: search.count })}
          </span>
        );
      })}
    </div>
  );
}

/**
 * «Fuentes · {kb}» under an answer (design `KbCitations`): «[n] {documento} · p. {página}».
 * Metadata only (D88 (44)): the text of a fragment never reaches the browser, so a source is a
 * line, not something to open. No link to the original either (D88).
 */
export function KnowledgeCitations({ citations }: { citations: readonly Citation[] }) {
  const { t } = useTranslation();
  if (!citations.length) return null;
  const bases = [...new Set(citations.map((citation) => citation.knowledgeBase))];
  const single = bases.length === 1 ? bases[0] : null;
  return (
    <section className="kb-cites" aria-label={t('chat.knowledge.sources')}>
      <div className="kb-cites-h">
        {single ? t('chat.knowledge.sourcesOf', { kb: single }) : t('chat.knowledge.sources')}
      </div>
      <ol className="contents">
        {citations.map((citation, index) => (
          <li
            key={`${citation.knowledgeBase}-${citation.document}-${String(citation.page)}`}
            className="kb-cite"
          >
            <span className="kb-cite-n">[{index + 1}]</span>
            <span className="kb-cite-d" title={citation.document}>
              {citation.document}
            </span>
            {citation.page !== null ? (
              <span className="kb-cite-m">{t('chat.knowledge.page', { page: citation.page })}</span>
            ) : null}
            {single === null ? <span className="kb-cite-m">· {citation.knowledgeBase}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
