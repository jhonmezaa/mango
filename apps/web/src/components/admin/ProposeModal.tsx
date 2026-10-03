import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AREA_PATTERN, REASON_MAX_LENGTH, type Units } from '../../api/adminSchemas';
import {
  MAX_AREAS,
  MAX_OUS_PER_AREA,
  diffUnits,
  mapToUnits,
  unitsToMap,
  type OuNode,
} from '../../lib/businessUnits';
import { PlusIcon, TrashIcon } from '../icons';
import type { DialogError } from './ChangeModals';
import { DiffView } from './DiffView';
import { Banner, GovModal, Reason } from './govKit';
import { OuChip } from './OuChip';
import { OuPicker } from './OuPicker';

interface Props {
  current: Units;
  version: number;
  tree: ReadonlyMap<string, OuNode> | null;
  nodes: readonly OuNode[] | null;
  myArea: string | null;
  busy: boolean;
  error: DialogError | null;
  sheet: boolean;
  onClose: () => void;
  onSubmit: (units: Units, reason: string) => void;
}

/**
 * Mapping editor (design `Propose`): areas and OUs on the left, the live diff and the required
 * reason on the right. The draft is a Map, so area names such as `constructor` stay plain keys
 * (ADM-02). Limits and "your area" only explain what the API enforces.
 */
export function ProposeModal({
  current,
  version,
  tree,
  nodes,
  myArea,
  busy,
  error,
  sheet,
  onClose,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  const newAreaId = useId();
  const reasonId = useId();
  const original = useMemo(() => unitsToMap(current), [current]);
  const [draft, setDraft] = useState<ReadonlyMap<string, readonly string[]>>(() => original);
  const [newArea, setNewArea] = useState('');
  const [areaTried, setAreaTried] = useState(false);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [emptyError, setEmptyError] = useState(false);
  const [emptyAreasTried, setEmptyAreasTried] = useState(false);
  const [picker, setPicker] = useState<string | null>(null);

  const units = useMemo(() => mapToUnits(draft), [draft]);
  const diffs = useMemo(() => diffUnits(current, units), [current, units]);
  const names = [
    ...[...original.keys()].filter((name) => draft.has(name)),
    ...[...draft.keys()].filter((name) => !original.has(name)),
  ];
  // The API refuses an area without OUs; say which ones before sending (design `Propose`).
  const emptyAreas = names.filter((name) => (draft.get(name) ?? []).length === 0);

  const value = newArea.trim();
  const areaError = !value
    ? t('settings.areas.editor.areaEmpty')
    : !/^[a-z0-9-]+$/.test(value)
      ? t('settings.areas.editor.areaChars')
      : !AREA_PATTERN.test(value)
        ? t('settings.areas.editor.areaLength')
        : draft.has(value) || original.has(value)
          ? t('settings.areas.editor.areaExists')
          : names.length >= MAX_AREAS
            ? t('settings.areas.editor.areaMax', { max: MAX_AREAS })
            : null;
  const reasonError = !reason.trim()
    ? t('settings.areas.editor.reasonRequired')
    : reason.length > REASON_MAX_LENGTH
      ? t('settings.areas.maxChars')
      : null;

  const setArea = (name: string, list: readonly string[]) => {
    setDraft((map) => new Map(map).set(name, list));
  };
  const removeArea = (name: string) => {
    setDraft((map) => {
      const next = new Map(map);
      next.delete(name);
      return next;
    });
  };
  const restoreArea = (name: string) => {
    setArea(name, [...(original.get(name) ?? [])]);
  };
  const addArea = () => {
    setAreaTried(true);
    if (areaError) return;
    setArea(value, []);
    setNewArea('');
    setAreaTried(false);
    setPicker(value);
  };
  const submit = () => {
    setTried(true);
    setEmptyError(diffs.length === 0);
    setEmptyAreasTried(diffs.length > 0 && emptyAreas.length > 0);
    if (diffs.length === 0 || emptyAreas.length > 0 || reasonError) return;
    onSubmit(units, reason.trim());
  };

  return (
    <GovModal
      title={t('settings.areas.editor.title')}
      sub={t('settings.areas.editor.sub')}
      onClose={onClose}
      width={1000}
      sheet={sheet}
      busy={busy}
      footer={
        <>
          <span className="g-sub mr-auto whitespace-nowrap">
            {t('settings.areas.editor.base', { version })}
          </span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onClose}>
            {error?.lock ? t('common.close') : t('common.cancel')}
          </button>
          {!error?.lock && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={submit}
            >
              {busy ? t('settings.areas.editor.sending') : t('settings.areas.editor.submit')}
            </button>
          )}
        </>
      }
    >
      {emptyError && diffs.length === 0 && (
        <Banner tone="error" title={t('settings.areas.editor.noChanges')}>
          {t('settings.areas.editor.noChangesBody')}
        </Banner>
      )}
      {emptyAreasTried && diffs.length > 0 && emptyAreas.length > 0 && (
        <Banner tone="error" title={t('settings.areas.editor.emptyAreas')}>
          {t('settings.areas.editor.emptyAreasBody', {
            count: emptyAreas.length,
            areas: emptyAreas.join(', '),
          })}
        </Banner>
      )}
      {error && (
        <Banner tone="error" title={error.title}>
          {error.body}
        </Banner>
      )}
      <div className="g-pgrid">
        <div className="g-pedit">
          <div className="g-sec-h mb-2">
            <span className="g-sec-t">{t('settings.areas.editor.areas')}</span>
            <span className="g-sec-meta g-num">
              {t('settings.areas.ofMax', { count: names.length, max: MAX_AREAS })}
            </span>
          </div>
          <div className="g-card">
            {names.map((name) => {
              const list = draft.get(name) ?? [];
              const orig = original.get(name) ?? [];
              const mine = name === myArea;
              const isNew = !original.has(name);
              const full = list.length >= MAX_OUS_PER_AREA;
              const removed = orig.filter((id) => !list.includes(id));
              return (
                <div key={name} className="g-erow">
                  <div className="g-erow-h">
                    <span className="g-area">{name}</span>
                    {mine && (
                      <span className="badge badge-accent">{t('settings.areas.yourArea')}</span>
                    )}
                    {isNew && <span className="g-dtag new">{t('settings.areas.editor.new')}</span>}
                    <span className="g-sub g-num ml-auto">
                      {t('settings.areas.ofMax', { count: list.length, max: MAX_OUS_PER_AREA })}
                    </span>
                    {!mine && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        aria-label={t('settings.areas.editor.removeArea', { area: name })}
                        title={t('settings.areas.editor.removeAreaTitle')}
                        onClick={() => {
                          removeArea(name);
                        }}
                      >
                        <TrashIcon size={13} />
                      </button>
                    )}
                  </div>
                  <div className="g-chips">
                    {list.map((id) => (
                      <OuChip
                        key={id}
                        id={id}
                        tree={tree}
                        kind={orig.includes(id) ? undefined : 'add'}
                        onRemove={
                          mine
                            ? null
                            : () => {
                                setArea(
                                  name,
                                  list.filter((item) => item !== id),
                                );
                              }
                        }
                      />
                    ))}
                    {removed.map((id) => (
                      <OuChip
                        key={id}
                        id={id}
                        tree={tree}
                        kind="rem"
                        onRestore={() => {
                          setArea(name, [...list, id]);
                        }}
                      />
                    ))}
                    {!mine && (
                      <span className="relative">
                        <button
                          type="button"
                          className="g-addou"
                          disabled={full}
                          aria-expanded={picker === name}
                          onClick={() => {
                            setPicker(picker === name ? null : name);
                          }}
                        >
                          <PlusIcon size={11} />
                          {t('settings.areas.editor.addOu')}
                        </button>
                        {picker === name && (
                          <OuPicker
                            area={name}
                            nodes={nodes}
                            draft={draft}
                            onPick={(id) => {
                              setArea(name, [...(draft.get(name) ?? []), id]);
                            }}
                            onClose={() => {
                              setPicker(null);
                            }}
                          />
                        )}
                      </span>
                    )}
                  </div>
                  {mine && <Reason>{t('settings.areas.editor.mine')}</Reason>}
                  {!mine && full && (
                    <div className="g-hint">
                      {t('settings.areas.editor.ouMax', { max: MAX_OUS_PER_AREA })}
                    </div>
                  )}
                  {!mine && list.length === 0 && (
                    <div className={tried ? 'g-err' : 'g-hint'}>
                      {t('settings.areas.editor.noOus')}
                    </div>
                  )}
                </div>
              );
            })}
            {names.length === 0 && (
              <div className="g-hint p-4">{t('settings.areas.editor.noAreas')}</div>
            )}
          </div>
          <div className="g-field mt-3.5">
            <label htmlFor={newAreaId}>{t('settings.areas.editor.newArea')}</label>
            <div className="flex gap-2">
              <input
                id={newAreaId}
                className={
                  areaTried && areaError
                    ? 'input mono has-error max-w-[280px] flex-1'
                    : 'input mono max-w-[280px] flex-1'
                }
                placeholder={t('settings.areas.editor.newAreaPlaceholder')}
                value={newArea}
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={areaTried && areaError ? true : undefined}
                aria-describedby={`${newAreaId}-h`}
                onChange={(event) => {
                  setNewArea(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addArea();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={names.length >= MAX_AREAS}
                onClick={addArea}
              >
                <PlusIcon size={11} />
                {t('settings.areas.editor.addArea')}
              </button>
            </div>
            <div id={`${newAreaId}-h`} className={areaTried && areaError ? 'g-err' : 'g-hint'}>
              {areaTried && areaError ? areaError : t('settings.areas.editor.newAreaHint')}
            </div>
          </div>
        </div>

        <div className="g-pside">
          <div className="g-sec-t mb-2">{t('settings.areas.editor.changes')}</div>
          <DiffView diffs={diffs} tree={tree} onRestore={restoreArea} />
          <div className="g-field mt-4.5">
            <div className="flex items-center justify-between">
              <label htmlFor={reasonId}>{t('settings.areas.editor.reason')}</label>
              <span
                className={
                  reason.length > REASON_MAX_LENGTH ? 'g-sub g-num g-err mt-0' : 'g-sub g-num'
                }
              >
                {reason.length} / {REASON_MAX_LENGTH}
              </span>
            </div>
            <textarea
              id={reasonId}
              className={tried && reasonError ? 'input has-error' : 'input'}
              rows={4}
              value={reason}
              placeholder={t('settings.areas.editor.reasonPlaceholder')}
              aria-invalid={tried && reasonError ? true : undefined}
              aria-describedby={`${reasonId}-h`}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <div id={`${reasonId}-h`} className={tried && reasonError ? 'g-err' : 'g-hint'}>
              {tried && reasonError ? reasonError : t('settings.areas.reasonHint')}
            </div>
          </div>
        </div>
      </div>
    </GovModal>
  );
}
