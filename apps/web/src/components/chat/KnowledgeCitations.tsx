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
      {searches.map((search, index) => (
        <span key={index} className="kb-step">
          <BookOpenIcon size={11} />
          {t('chat.knowledge.searched')}{' '}
          <b>
            {search.knowledgeBases.length
              ? search.knowledgeBases.join(', ')
              : t('chat.knowledge.anyBase')}
          </b>
          {' · '}
          {t('chat.knowledge.fragments', { count: search.count })}
        </span>
      ))}
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
            <span className="kb-cite-d">{citation.document}</span>
            {citation.page !== null ? (
              <span className="mk-meta flex-none">
                {t('chat.knowledge.page', { page: citation.page })}
              </span>
            ) : null}
            {single === null ? (
              <span className="mk-meta flex-none">· {citation.knowledgeBase}</span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
