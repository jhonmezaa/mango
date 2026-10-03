import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { ouIdSchema } from '../../api/adminSchemas';
import { MAX_OUS_PER_AREA, type OuNode } from '../../lib/businessUnits';
import { SearchIcon } from '../icons';

interface Props {
  area: string;
  /** Tree order from the organization, or null when it could not be read (manual IDs). */
  nodes: readonly OuNode[] | null;
  draft: ReadonlyMap<string, readonly string[]>;
  onPick: (id: string) => void;
  onClose: () => void;
}

/** Popover to add an OU to an area: tree search, or a typed ID without the tree (design `OuPicker`). */
export function OuPicker({ area, nodes, draft, onPick, onClose }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const errorId = useId();
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState('');
  const [tried, setTried] = useState(false);
  const current = draft.get(area) ?? [];
  const full = current.length >= MAX_OUS_PER_AREA;
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (ref.current && target && !ref.current.contains(target) && !target.closest('.g-addou')) {
        onCloseRef.current();
      }
    };
    document.addEventListener('mousedown', onDown);
    ref.current?.querySelector('input')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, []);

  // Escape closes only the popover, not the dialog around it.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  if (!nodes) {
    const value = manual.trim();
    const error = !ouIdSchema.safeParse(value).success
      ? t('settings.areas.picker.format')
      : current.includes(value)
        ? t('settings.areas.picker.already')
        : null;
    const add = () => {
      setTried(true);
      if (!error && !full) {
        onPick(value);
        setManual('');
        setTried(false);
      }
    };
    return (
      <div className="g-pop" ref={ref} onKeyDown={onKeyDown}>
        <div className="g-sub mb-2">{t('settings.areas.picker.noTree')}</div>
        <div className="flex gap-2">
          <input
            className={tried && error ? 'input mono has-error flex-1' : 'input mono flex-1'}
            placeholder="ou-xxxx-xxxxxxxx"
            aria-label={t('settings.areas.picker.manualLabel', { area })}
            maxLength={80}
            spellCheck={false}
            autoComplete="off"
            value={manual}
            aria-invalid={tried && error ? true : undefined}
            aria-describedby={tried && error ? errorId : undefined}
            onChange={(event) => {
              setManual(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="btn btn-sm" disabled={full} onClick={add}>
            {t('settings.areas.picker.add')}
          </button>
        </div>
        {tried && error && (
          <div id={errorId} className="g-err">
            {error}
          </div>
        )}
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const items = needle
    ? nodes.filter((ou) => `${ou.name} ${ou.id} ${ou.label}`.toLowerCase().includes(needle))
    : nodes;
  const elsewhere = (id: string) =>
    [...draft].filter(([name, ous]) => name !== area && ous.includes(id)).map(([name]) => name);

  return (
    <div
      className="g-pop"
      ref={ref}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-label={t('settings.areas.picker.title', { area })}
    >
      <div className="search-wrap">
        <SearchIcon size={12} />
        <input
          className="input"
          placeholder={t('settings.areas.picker.search')}
          aria-label={t('settings.areas.picker.search')}
          maxLength={100}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>
      {full && <div className="g-hint px-0.5 pt-2">{t('settings.areas.picker.full')}</div>}
      <div className="g-pop-list" role="listbox" aria-label={t('settings.areas.picker.list')}>
        {items.map((ou) => {
          const has = current.includes(ou.id);
          const others = has ? [] : elsewhere(ou.id);
          return (
            <button
              key={ou.id}
              type="button"
              role="option"
              aria-selected={has}
              disabled={has || full}
              style={{ paddingLeft: 10 + (needle ? 0 : ou.depth * 16) }}
              onClick={() => {
                onPick(ou.id);
              }}
            >
              <span className="g-pop-main">
                <span className="g-ou-n">{ou.name}</span>
                <span className="g-id">{ou.id}</span>
              </span>
              {needle && <span className="g-pop-path">{ou.label}</span>}
              {has ? (
                <span className="g-pop-path">{t('settings.areas.picker.added')}</span>
              ) : (
                others.length > 0 && (
                  <span className="g-pop-path">
                    {t('settings.areas.picker.alsoIn', { areas: others.join(', ') })}
                  </span>
                )
              )}
            </button>
          );
        })}
        {items.length === 0 && (
          <div className="g-hint p-3">{t('settings.areas.picker.noMatch')}</div>
        )}
      </div>
    </div>
  );
}
