import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { ArrowRightIcon, DocumentIcon, TerminalIcon } from '../../icons';
import { isCode, LANGUAGE, useCanvasOpener, type TextdocCard } from './canvasApi';

/**
 * Design round 41: the card of a Canvas document in the answer that wrote it; it opens the
 * Canvas (with code, the terminal icon). Its title came from the model: rendered as text.
 */
export const CanvasCard = memo(function CanvasCard({ card }: { card: TextdocCard }) {
  const { t } = useTranslation();
  const { open } = useCanvasOpener();
  const code = isCode(card.kind);
  return (
    <button
      type="button"
      className="card cv-card"
      aria-label={`${t('chat.canvas.card')}: ${card.title}`}
      onClick={() => {
        open(card);
      }}
    >
      <span className="cv-card-ic">
        {code ? <TerminalIcon size={16} /> : <DocumentIcon size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="cv-card-t">{card.title}</span>
        <span className="cv-card-s">
          {code
            ? t('chat.canvas.cardMetaCode', { language: LANGUAGE[card.kind], n: card.version })
            : t('chat.canvas.cardMetaDocument', { n: card.version })}
        </span>
      </span>
      <ArrowRightIcon size={12} />
    </button>
  );
});
