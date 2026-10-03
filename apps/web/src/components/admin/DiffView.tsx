import { useTranslation } from 'react-i18next';

import type { AreaDiff, OuNode } from '../../lib/businessUnits';
import { OuChip } from './OuChip';

const KIND_CLASS = { added: 'new', removed: 'removed', changed: 'changed' } as const;

interface Props {
  diffs: readonly AreaDiff[];
  tree: ReadonlyMap<string, OuNode> | null;
  /** Editor only: brings back a removed area. */
  onRestore?: ((area: string) => void) | undefined;
}

/** Per-area difference of a proposal against the current mapping (design `DiffView`, TM-A1). */
export function DiffView({ diffs, tree, onRestore }: Props) {
  const { t } = useTranslation();
  if (diffs.length === 0) return <div className="g-hint">{t('settings.areas.diff.none')}</div>;
  return (
    <div className="g-diff">
      {diffs.map((diff) => (
        <div key={diff.area} className="g-diff-row">
          <div className="flex flex-wrap items-center gap-2">
            <span className="g-area">{diff.area}</span>
            <span className={`g-dtag ${KIND_CLASS[diff.kind]}`}>
              {t(`settings.areas.diff.${diff.kind}`)}
            </span>
            {onRestore && diff.kind === 'removed' && (
              <button
                type="button"
                className="g-link"
                onClick={() => {
                  onRestore(diff.area);
                }}
              >
                {t('settings.areas.diff.restore')}
              </button>
            )}
          </div>
          {diff.added.length > 0 && (
            <div className="g-diff-line">
              <span className="g-diff-k">{t('settings.areas.diff.adds')}</span>
              <div className="g-chips">
                {diff.added.map((id) => (
                  <OuChip key={id} id={id} tree={tree} kind="add" />
                ))}
              </div>
            </div>
          )}
          {diff.removed.length > 0 && (
            <div className="g-diff-line">
              <span className="g-diff-k">{t('settings.areas.diff.removes')}</span>
              <div className="g-chips">
                {diff.removed.map((id) => (
                  <OuChip key={id} id={id} tree={tree} kind="rem" />
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
