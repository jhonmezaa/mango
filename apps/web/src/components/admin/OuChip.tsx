import { useTranslation } from 'react-i18next';

import type { OuNode } from '../../lib/businessUnits';
import { CloseIcon, RefreshIcon } from '../icons';

interface Props {
  id: string;
  /** Null when the organization could not be read: only the ID is shown. */
  tree: ReadonlyMap<string, OuNode> | null;
  kind?: 'add' | 'rem' | undefined;
  onRemove?: (() => void) | null | undefined;
  onRestore?: (() => void) | undefined;
}

/** OU name (from AWS Organizations, untrusted: rendered as text, TM-A8) and its ID (design `OuChip`). */
export function OuChip({ id, tree, kind, onRemove, onRestore }: Props) {
  const { t } = useTranslation();
  const ou = tree?.get(id);
  const name = ou?.name;
  const label = name ?? id;
  return (
    <span className={kind ? `g-ou ${kind}` : 'g-ou'} title={ou?.label ?? id} data-kind={kind}>
      {kind === 'add' && (
        <span className="g-ou-sign" aria-label={t('settings.areas.chip.adds')}>
          +
        </span>
      )}
      {kind === 'rem' && (
        <span className="g-ou-sign" aria-label={t('settings.areas.chip.removes')}>
          −
        </span>
      )}
      {name && <span className="g-ou-n">{name}</span>}
      <span className="g-id">{id}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={t('settings.areas.chip.remove', { name: label })}
          onClick={onRemove}
        >
          <CloseIcon size={11} />
        </button>
      )}
      {onRestore && (
        <button
          type="button"
          aria-label={t('settings.areas.chip.restore', { name: label })}
          title={t('settings.areas.chip.restoreTitle')}
          onClick={onRestore}
        >
          <RefreshIcon size={11} />
        </button>
      )}
    </span>
  );
}
