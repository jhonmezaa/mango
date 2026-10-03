import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GovModal } from '../../components/admin/govKit';
import { InfoIcon, TrashIcon } from '../../components/icons';
import {
  CHANGE_TTL_HOURS,
  DESCRIPTION_MAX_LENGTH,
  GROUP_TYPES,
  MAX_GROUPS,
  NEW_GROUP,
  REASON_MAX_LENGTH,
  accountDataAgents,
  draftOf,
  isAreaGroupName,
  isNewGroupName,
  isReservedName,
  needsApproval,
  type Group,
  type GroupDraft,
  type GroupType,
  type Proposal,
} from './model';

interface Props {
  /** The group being edited; null for a new one. */
  group: Group | null;
  /** Names already taken (registry and pending creations). */
  taken: ReadonlySet<string>;
  /** Groups of the administrator (verified token): nobody changes a group they belong to. */
  ownGroups: readonly string[];
  /** Areas of the current mapping with their number of OUs, for an area group. */
  areas: ReadonlyMap<string, number>;
  onClose: () => void;
  onGoAreas: () => void;
  /** Sends a request for another administrator; resolves to an error text or null. */
  onPropose: (proposal: Proposal) => Promise<string | null>;
  /** Saves the description alone (no approval); resolves to an error text or null. */
  onSaveDescription: (group: Group, description: string) => Promise<string | null>;
}

const MAX_NAMES = 4;

/**
 * Create or edit a group (design `GroupModal`). The checks here only guide the administrator:
 * the API validates the request again and decides (names, areas, central groups in use, who
 * may propose). Group, area and agent names are rendered as text.
 */
export function GroupModal({
  group,
  taken,
  ownGroups,
  areas,
  onClose,
  onGoAreas,
  onPropose,
  onSaveDescription,
}: Props) {
  const { t } = useTranslation();
  const ids = useId();
  const isNew = group === null;
  const firstArea = areas.keys().next().value ?? null;
  const [draft, setDraft] = useState<GroupDraft>(() => {
    const initial = group ? draftOf(group) : NEW_GROUP;
    return { ...initial, area: initial.area ?? (initial.type === 'area' ? firstArea : null) };
  });
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const approval = needsApproval(group, draft);
  const used = group?.agents ?? [];
  const holding = group ? accountDataAgents(group) : [];
  const idError = !isNew
    ? null
    : !draft.id
      ? t('groups.modal.errors.nameRequired')
      : !isNewGroupName(draft.id)
        ? t('groups.modal.errors.nameFormat')
        : isReservedName(draft.id)
          ? t('groups.modal.errors.nameReserved')
          : taken.has(draft.id)
            ? t('groups.modal.errors.nameTaken')
            : taken.size >= MAX_GROUPS
              ? t('groups.modal.errors.tooMany', { max: MAX_GROUPS })
              : null;
  // Design order: what the name fixes, then the administrator's own group, then agents in use.
  const typeError =
    isAreaGroupName(draft.id) && draft.type !== 'area'
      ? t('groups.modal.errors.typeFixedArea')
      : isNew && draft.type === 'area' && !isAreaGroupName(draft.id)
        ? t('groups.modal.errors.typeNeedsAreaName')
        : group && approval && ownGroups.includes(group.id)
          ? t('groups.modal.errors.ownGroup')
          : group?.type === 'central' && draft.type !== 'central' && holding.length > 0
            ? t('groups.modal.errors.centralInUse', {
                count: holding.length,
                names: holding.map((agent) => agent.name).join(', '),
              })
            : null;
  const areaError = draft.type === 'area' && !draft.area ? t('groups.modal.errors.area') : null;
  const reasonMissing = (approval || confirmDelete) && !reason.trim();

  const send = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setServerError(null);
    try {
      const error = await action();
      if (error === null) onClose();
      else setServerError(error);
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    setTried(true);
    if (idError || typeError || areaError) return;
    const area = draft.type === 'area' ? draft.area : null;
    if (!group) {
      if (reasonMissing) return;
      void send(() =>
        onPropose({
          kind: 'create',
          group_id: draft.id,
          type: draft.type,
          area,
          description: draft.description.trim(),
          reason: reason.trim(),
        }),
      );
      return;
    }
    const description = draft.description.trim();
    if (!approval) {
      // Nothing to save: the dialog just closes.
      if (description === group.description) onClose();
      else void send(() => onSaveDescription(group, description));
      return;
    }
    if (reasonMissing) return;
    void send(() =>
      onPropose({
        kind: 'update',
        group_id: group.id,
        type: draft.type,
        area,
        description,
        base_version: group.version,
        reason: reason.trim(),
      }),
    );
  };

  const remove = () => {
    setTried(true);
    if (!group || !reason.trim()) return;
    void send(() =>
      onPropose({
        kind: 'delete',
        group_id: group.id,
        base_version: group.version,
        reason: reason.trim(),
      }),
    );
  };

  const setType = (type: GroupType) => {
    setDraft((current) => ({
      ...current,
      type,
      area: type === 'area' ? (current.area ?? firstArea) : null,
    }));
  };

  return (
    <GovModal
      title={group ? t('groups.modal.editTitle', { id: group.id }) : t('groups.modal.newTitle')}
      sub={t('groups.modal.sub')}
      onClose={onClose}
      busy={busy}
      footer={
        <div className="gr-foot">
          {group ? (
            confirmDelete ? (
              <>
                <span className="mk-meta">
                  {used.length > 0 ? t('groups.modal.deleteUsed') : t('groups.modal.deleteAsk')}
                </span>
                <button
                  type="button"
                  className="btn btn-sm mk-danger"
                  disabled={busy}
                  onClick={remove}
                >
                  {t('groups.modal.proposeDelete')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    setConfirmDelete(false);
                    setServerError(null);
                  }}
                >
                  {t('groups.modal.no')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-ghost gr-delete"
                disabled={group.system || busy}
                title={group.system ? t('groups.modal.systemGroup') : undefined}
                onClick={() => {
                  setConfirmDelete(true);
                  setTried(false);
                  setServerError(null);
                }}
              >
                <TrashIcon size={12} />
                {t('groups.modal.delete')}
              </button>
            )
          ) : null}
          <div className="gr-foot-spacer" />
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onClose}>
            {t('groups.modal.cancel')}
          </button>
          {confirmDelete ? null : (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>
              {approval ? t('groups.modal.submit') : t('groups.modal.save')}
            </button>
          )}
        </div>
      }
    >
      <div className="gr-form">
        <div>
          <label htmlFor={`${ids}-id`} className="gr-label">
            {t('groups.modal.name')}
          </label>
          <input
            id={`${ids}-id`}
            className={tried && idError ? 'input mono gr-invalid' : 'input mono'}
            value={draft.id}
            disabled={!isNew}
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('groups.modal.namePlaceholder')}
            aria-invalid={tried && idError ? true : undefined}
            aria-describedby={`${ids}-id-help`}
            onChange={(event) => {
              setDraft((current) => ({ ...current, id: event.target.value }));
              setServerError(null);
            }}
          />
          {tried && idError ? (
            <div id={`${ids}-id-help`} className="gr-field-error" role="alert">
              {idError}
            </div>
          ) : isNew ? null : (
            <div id={`${ids}-id-help`} className="mk-meta gr-field-hint">
              {t('groups.modal.nameFixed')}
            </div>
          )}
        </div>
        <div>
          <label htmlFor={`${ids}-desc`} className="gr-label">
            {t('groups.modal.description')}
          </label>
          <input
            id={`${ids}-desc`}
            className="input"
            value={draft.description}
            maxLength={DESCRIPTION_MAX_LENGTH}
            placeholder={t('groups.modal.descriptionPlaceholder')}
            onChange={(event) => {
              setDraft((current) => ({ ...current, description: event.target.value }));
            }}
          />
        </div>
        <fieldset>
          <legend className="gr-label">{t('groups.modal.type')}</legend>
          <div className="gr-types">
            {GROUP_TYPES.map((type) => (
              <label key={type} className={draft.type === type ? 'gr-type is-on' : 'gr-type'}>
                <input
                  type="radio"
                  name={`${ids}-type`}
                  checked={draft.type === type}
                  onChange={() => {
                    setType(type);
                  }}
                />
                <span>
                  <span className="gr-type-name">{t(`groups.types.${type}`)}</span>
                  <span className="mk-meta">{t(`groups.typeHints.${type}`)}</span>
                </span>
              </label>
            ))}
          </div>
          {tried && typeError ? (
            <div className="gr-field-error" role="alert">
              {typeError}
            </div>
          ) : null}
        </fieldset>
        {draft.type === 'area' ? (
          <div>
            <label htmlFor={`${ids}-area`} className="gr-label">
              {t('groups.modal.area')}
            </label>
            <select
              id={`${ids}-area`}
              className="input gr-area-select"
              value={draft.area ?? ''}
              onChange={(event) => {
                setDraft((current) => ({ ...current, area: event.target.value || null }));
              }}
            >
              {[...areas].map(([area, count]) => (
                <option key={area} value={area}>
                  {t('groups.modal.areaOption', { area, count })}
                </option>
              ))}
            </select>
            {tried && areaError ? (
              <div className="gr-field-error" role="alert">
                {areaError}
              </div>
            ) : null}
            <div className="mk-meta gr-field-hint">
              {t('groups.modal.areaHint')}{' '}
              <button type="button" className="gr-link" onClick={onGoAreas}>
                {t('groups.modal.areaLink')}
              </button>
              {t('groups.modal.areaHintEnd')}
            </div>
          </div>
        ) : null}
        {approval || confirmDelete ? (
          <div>
            <label htmlFor={`${ids}-why`} className="gr-label">
              {t('groups.modal.reason')}
            </label>
            <textarea
              id={`${ids}-why`}
              className={tried && reasonMissing ? 'input gr-invalid' : 'input'}
              rows={2}
              maxLength={REASON_MAX_LENGTH}
              value={reason}
              placeholder={t('groups.modal.reasonPlaceholder')}
              aria-invalid={tried && reasonMissing ? true : undefined}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            {tried && reasonMissing ? (
              <div className="gr-field-error" role="alert">
                {t('groups.modal.errors.reason')}
              </div>
            ) : null}
            <div className="mk-meta gr-field-hint">
              {confirmDelete
                ? t('groups.modal.reasonHintDelete')
                : isNew
                  ? t('groups.modal.reasonHintCreate')
                  : t('groups.modal.reasonHintUpdate')}{' '}
              {t('groups.modal.reasonHintExpires', { hours: CHANGE_TTL_HOURS })}
            </div>
          </div>
        ) : null}
        {used.length > 0 ? (
          <div className="mc-alert">
            <InfoIcon size={14} />
            <div>
              {t('groups.modal.usedBy', {
                count: used.length,
                names:
                  used
                    .slice(0, MAX_NAMES)
                    .map((agent) => agent.name)
                    .join(', ') + (used.length > MAX_NAMES ? '…' : ''),
              })}
            </div>
          </div>
        ) : null}
        {serverError ? (
          <div className="g-err" role="alert">
            {serverError}
          </div>
        ) : null}
      </div>
    </GovModal>
  );
}
