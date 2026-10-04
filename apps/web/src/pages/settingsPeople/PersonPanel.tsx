import { useId, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { MfaReset } from '../../api/mfaResetSchemas';
import type { Me } from '../../api/schemas';
import { Reason } from '../../components/admin/govKit';
import { ChevronLeftIcon, CloseIcon, LockIcon } from '../../components/icons';
import { PersonChip } from '../../components/PersonChip';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { TYPE_BADGE } from '../settingsGroups/model';
import { peopleErrorKey } from './errors';
import {
  ADMIN_GROUP,
  REASON_MAX_LENGTH,
  formatJoined,
  isEnabledAdmin,
  isSelf,
  isSensitive,
  type GroupOption,
  type MemberChange,
  type Person,
} from './model';
import { PersonStatusBadge } from './PersonStatus';

/** What the panel asks for. Each one rejects with the API failure when it was not applied. */
export interface PersonActions {
  addGroup: (group: string, reason: string | undefined) => Promise<void>;
  removeGroup: (group: string, reason: string | undefined) => Promise<void>;
  disable: (reason: string) => Promise<void>;
  enable: (reason: string | undefined) => Promise<void>;
  resetMfa: (reason: string) => Promise<void>;
}

interface Props {
  person: Person;
  me: Me;
  /** Enabled administrators, as the directory counted them. */
  admins: number;
  options: readonly GroupOption[];
  /** Invited from another company: the domain is not one of those that sign up alone. */
  external: boolean;
  /** Open changes of this person. */
  pending: readonly MemberChange[];
  /** The open MFA reset of this person, if any. */
  mfaPending: MfaReset | undefined;
  actions: PersonActions;
  onClose: () => void;
}

type Open = null | { kind: 'remove'; group: string } | { kind: 'mfa' | 'disable' | 'enable' };

function ReasonBox({
  value,
  onChange,
  placeholder,
  label,
  invalid = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  invalid?: boolean;
}) {
  return (
    <textarea
      className={invalid ? 'input pp-invalid' : 'input'}
      rows={2}
      maxLength={REASON_MAX_LENGTH}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={invalid || undefined}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}

/**
 * Panel of one person (design `PersonPanel`): their groups, the MFA reset and their access.
 * What is disabled or labelled «con aprobación» here mirrors the rules to spare a round trip:
 * the API decides whether a change is applied, proposed or refused (REACT-AUTHZ-001). Emails,
 * group names and descriptions are API data, rendered as text.
 */
export function PersonPanel({
  person,
  me,
  admins,
  options,
  external,
  pending,
  mfaPending,
  actions,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const ref = useFocusTrap<HTMLElement>(true, onClose);
  // Design: full screen with «Volver» up to 560 px; the close button otherwise.
  const narrow = useMediaQuery('(max-width: 560px)');
  const selectId = useId();
  const [add, setAdd] = useState('');
  const [addReason, setAddReason] = useState('');
  const [addTried, setAddTried] = useState(false);
  // One form open at a time: its reason does not outlive it.
  const [open, setOpen] = useState<Open>(null);
  const [reason, setReason] = useState('');
  const [verified, setVerified] = useState(false);
  const [mfaTried, setMfaTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const self = isSelf(me, person);
  const disabled = person.status === 'disabled';
  const admin = isEnabledAdmin(person);
  const byId = new Map(options.map((group) => [group.id, group]));
  const pendingAdds = pending.filter((change) => change.kind === 'add');
  const removing = new Set(
    pending.filter((change) => change.kind === 'remove').map((change) => change.group),
  );
  const disablePending = pending.find((change) => change.kind === 'disable');
  const enablePending = pending.find((change) => change.kind === 'enable');
  const available = options.filter(
    (group) =>
      !person.groups.includes(group.id) && !pendingAdds.some((change) => change.group === group.id),
  );
  const sensitive = isSensitive(add);
  const bootstrap = add === ADMIN_GROUP && admins === 1;
  const needsReason = sensitive && !bootstrap;
  const fewAdmins = admins <= 2;
  // Re-enabling someone with a sensitive group is approved by another administrator.
  const enableSensitive = person.groups.some(isSensitive);

  const show = (next: Open) => {
    setOpen(next);
    setReason('');
    setVerified(false);
    setMfaTried(false);
  };
  const run = (action: () => Promise<void>, done: () => void) => {
    setError(null);
    setBusy(true);
    void action()
      .then(done, (failure: unknown) => {
        setError(t(peopleErrorKey(failure)));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const close = () => {
    show(null);
  };

  const submitAdd = () => {
    setAddTried(true);
    if (!add || (needsReason && !addReason.trim())) return;
    run(
      () => actions.addGroup(add, needsReason ? addReason.trim() : undefined),
      () => {
        setAdd('');
        setAddReason('');
        setAddTried(false);
      },
    );
  };
  const mfaError = !reason.trim()
    ? t('people.panel.mfa.reasonRequired')
    : !verified
      ? t('people.panel.mfa.verifiedRequired')
      : null;

  const typeBadge = (id: string): ReactNode => {
    const group = byId.get(id);
    return group ? (
      <span className={`badge ${TYPE_BADGE[group.type]}`}>
        {group.system ? t('people.panel.groups.system') : ''}
        {t(`groups.types.${group.type}`)}
      </span>
    ) : null;
  };
  const describe = (id: string): string => {
    const texts = t('people.panel.groups.descriptions', { returnObjects: true });
    const extras = t('people.panel.groups.extra', { returnObjects: true });
    const fallback = Object.hasOwn(texts, id) ? texts[id as keyof typeof texts] : '';
    const extra = Object.hasOwn(extras, id) ? extras[id as keyof typeof extras] : '';
    return `${byId.get(id)?.description || fallback}${extra}`;
  };
  const cancel = (
    <button type="button" className="btn btn-sm" disabled={busy} onClick={close}>
      {t('people.panel.cancel')}
    </button>
  );

  return createPortal(
    <div className="g-frame g-portal">
      <div
        className="pp-scrim"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <aside
          ref={ref}
          className="pp-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={t('people.panel.label', { email: person.email })}
        >
          <div className="pp-drawer-h">
            {narrow ? (
              <button type="button" className="btn btn-sm btn-ghost pp-back" onClick={onClose}>
                <ChevronLeftIcon size={12} />
                {t('people.panel.back')}
              </button>
            ) : null}
            <div className="pp-drawer-id">
              <PersonChip email={person.email} size="lg" />
              <div className="pp-drawer-meta">
                <PersonStatusBadge person={person} />
                <span className="mk-meta">
                  {person.mfa ? t('people.panel.mfaRegistered') : t('people.panel.mfaMissing')}
                </span>
                <span className="mk-meta">
                  {t('people.panel.created', { date: formatJoined(person.created_at) })}
                </span>
                {self ? <span className="badge">{t('people.panel.yours')}</span> : null}
                {external ? (
                  <span className="badge" title={t('people.externalTitle')}>
                    {t('people.panel.external')}
                  </span>
                ) : null}
              </div>
            </div>
            {narrow ? null : (
              <button
                type="button"
                className="btn btn-ghost btn-icon pp-x"
                aria-label={t('common.close')}
                onClick={onClose}
              >
                <CloseIcon size={14} />
              </button>
            )}
          </div>
          <div className="pp-drawer-b">
            {error ? (
              <div className="g-err" role="alert">
                {error}
              </div>
            ) : null}
            {person.status === 'invited' ? <Reason>{t('people.panel.invited')}</Reason> : null}

            <section aria-labelledby={`${selectId}-groups`}>
              <h3 id={`${selectId}-groups`} className="pp-sec-t">
                {t('people.panel.groups.title')}
              </h3>
              {disabled ? (
                <Reason>{t('people.panel.groups.disabled')}</Reason>
              ) : (
                <>
                  {person.groups.length === 0 ? (
                    <div className="mk-meta mb-2">{t('people.panel.groups.none')}</div>
                  ) : null}
                  <ul className="pp-glist">
                    {person.groups.map((group) => {
                      const leaving = removing.has(group);
                      const blockSelf = self && isSensitive(group);
                      const blockLast = group === ADMIN_GROUP && fewAdmins;
                      const asking = open?.kind === 'remove' && open.group === group;
                      return (
                        <li key={group} className="pp-gi">
                          <div className="pp-gi-row">
                            <span className="mono pp-gi-name">{group}</span>
                            {typeBadge(group)}
                            {leaving ? (
                              <span className="badge badge-amber">
                                {t('people.panel.groups.removePending')}
                              </span>
                            ) : null}
                            <div className="pp-spacer" />
                            {!leaving && !asking ? (
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                aria-label={t('people.panel.groups.removeNamed', { group })}
                                disabled={busy || blockSelf || blockLast}
                                title={
                                  blockSelf
                                    ? t('people.panel.groups.removeSelf')
                                    : blockLast
                                      ? t('people.panel.groups.removeLast')
                                      : undefined
                                }
                                onClick={() => {
                                  if (isSensitive(group)) show({ kind: 'remove', group });
                                  else run(() => actions.removeGroup(group, undefined), close);
                                }}
                              >
                                {t('people.panel.groups.remove')}
                              </button>
                            ) : null}
                          </div>
                          {blockLast && !blockSelf ? (
                            <div className="mk-meta pp-gi-note">
                              {t('people.panel.groups.lastAdmins')}
                            </div>
                          ) : null}
                          {asking ? (
                            <div className="pp-form">
                              <ReasonBox
                                value={reason}
                                onChange={setReason}
                                placeholder={t('people.panel.groups.reasonPlaceholder')}
                                label={t('people.panel.groups.removeReasonLabel')}
                              />
                              <div className="pp-form-actions">
                                {cancel}
                                <button
                                  type="button"
                                  className="btn btn-sm btn-primary"
                                  disabled={!reason.trim() || busy}
                                  onClick={() => {
                                    run(() => actions.removeGroup(group, reason.trim()), close);
                                  }}
                                >
                                  {t('people.panel.groups.sendToApproval')}
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                    {pendingAdds.map((change) => (
                      <li key={change.change_id} className="pp-gi is-pending">
                        <div className="pp-gi-row">
                          <span className="mono pp-gi-name">{change.group}</span>
                          {change.group ? typeBadge(change.group) : null}
                          <span className="badge badge-amber">
                            {t('people.panel.groups.addPending')}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="pp-add">
                    <label htmlFor={selectId} className="pp-lbl">
                      {t('people.panel.groups.add')}
                    </label>
                    <div className="pp-add-row">
                      <select
                        id={selectId}
                        className="input"
                        value={add}
                        onChange={(event) => {
                          setAdd(event.target.value);
                          setAddTried(false);
                        }}
                      >
                        <option value="">{t('people.panel.groups.choose')}</option>
                        <optgroup label={t('people.panel.groups.ofSystem')}>
                          {available
                            .filter((group) => group.system)
                            .map((group) => (
                              <option key={group.id} value={group.id}>
                                {group.id}
                                {isSensitive(group.id) ? t('people.panel.groups.withApproval') : ''}
                              </option>
                            ))}
                        </optgroup>
                        {available.some((group) => !group.system) ? (
                          <optgroup label={t('people.panel.groups.ofAccess')}>
                            {available
                              .filter((group) => !group.system)
                              .map((group) => (
                                <option key={group.id} value={group.id}>
                                  {group.id}
                                  {group.area
                                    ? t('people.panel.groups.optionArea', { area: group.area })
                                    : ''}
                                </option>
                              ))}
                          </optgroup>
                        ) : null}
                      </select>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={!add || busy}
                        onClick={submitAdd}
                      >
                        {needsReason
                          ? t('people.panel.groups.sendToApproval')
                          : t('people.panel.groups.addSubmit')}
                      </button>
                    </div>
                    {add ? <div className="mk-meta pp-add-desc">{describe(add)}</div> : null}
                    {needsReason ? (
                      <div className="g-field pp-form">
                        <ReasonBox
                          value={addReason}
                          onChange={setAddReason}
                          placeholder={t('people.panel.groups.reasonPlaceholder')}
                          label={t('people.panel.groups.addReasonLabel')}
                          invalid={addTried && !addReason.trim()}
                        />
                        {addTried && !addReason.trim() ? (
                          <div className="g-err" role="alert">
                            {t('people.panel.groups.reasonRequired')}
                          </div>
                        ) : (
                          <div className="g-hint">{t('people.panel.groups.approvalHint')}</div>
                        )}
                      </div>
                    ) : null}
                    {bootstrap ? (
                      <Reason tone="warn">{t('people.panel.groups.bootstrap')}</Reason>
                    ) : null}
                  </div>
                </>
              )}
            </section>

            <section aria-labelledby={`${selectId}-mfa`}>
              <h3 id={`${selectId}-mfa`} className="pp-sec-t">
                {t('people.panel.mfa.title')}
              </h3>
              {self ? (
                <Reason>{t('people.panel.mfa.self')}</Reason>
              ) : !person.mfa ? (
                <div className="mk-meta">{t('people.panel.mfa.missing')}</div>
              ) : mfaPending ? (
                <div className="pp-line">
                  <span className="badge badge-amber">{t('people.panel.mfa.pending')}</span>
                  <span className="mk-meta mono">{mfaPending.change_id.slice(0, 8)}</span>
                  <span className="mk-meta">{t('people.panel.mfa.pendingWhere')}</span>
                </div>
              ) : open?.kind !== 'mfa' ? (
                <div className="pp-line">
                  <span className="mk-meta">{t('people.panel.mfa.body')}</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={disabled}
                    onClick={() => {
                      show({ kind: 'mfa' });
                    }}
                  >
                    {t('people.panel.mfa.open')}
                  </button>
                </div>
              ) : (
                <div className="pp-form">
                  <ReasonBox
                    value={reason}
                    onChange={setReason}
                    placeholder={t('people.panel.mfa.reasonPlaceholder')}
                    label={t('people.panel.mfa.reasonLabel')}
                  />
                  <label className="pp-check">
                    <input
                      type="checkbox"
                      checked={verified}
                      onChange={(event) => {
                        setVerified(event.target.checked);
                      }}
                    />
                    <span>
                      {t('people.panel.mfa.verified')}{' '}
                      <span className="pp-check-hint">{t('people.panel.mfa.verifiedHint')}</span>
                    </span>
                  </label>
                  {mfaTried && mfaError ? (
                    <div className="g-err" role="alert">
                      {mfaError}
                    </div>
                  ) : null}
                  <div className="pp-form-actions">
                    {cancel}
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={busy}
                      onClick={() => {
                        setMfaTried(true);
                        if (!mfaError) run(() => actions.resetMfa(reason.trim()), close);
                      }}
                    >
                      {t('people.panel.mfa.submit')}
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section aria-labelledby={`${selectId}-access`}>
              <h3 id={`${selectId}-access`} className="pp-sec-t">
                {t('people.panel.access.title')}
              </h3>
              {disabled ? (
                enablePending ? (
                  <div className="pp-line">
                    <span className="badge badge-amber">
                      {t('people.panel.access.enablePending')}
                    </span>
                    <span className="mk-meta mono">{enablePending.change_id.slice(0, 8)}</span>
                  </div>
                ) : enableSensitive && open?.kind !== 'enable' ? (
                  <div className="pp-line">
                    <span className="mk-meta">{t('people.panel.access.enableSensitive')}</span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        show({ kind: 'enable' });
                      }}
                    >
                      {t('people.panel.access.enableOpen')}
                    </button>
                  </div>
                ) : enableSensitive ? (
                  <div className="pp-form">
                    <span className="mk-meta">{t('people.panel.access.enableSensitiveForm')}</span>
                    <ReasonBox
                      value={reason}
                      onChange={setReason}
                      placeholder={t('people.panel.groups.reasonPlaceholder')}
                      label={t('people.panel.access.enableReasonLabel')}
                    />
                    <div className="pp-form-actions">
                      {cancel}
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={!reason.trim() || busy}
                        onClick={() => {
                          run(() => actions.enable(reason.trim()), close);
                        }}
                      >
                        {t('people.panel.groups.sendToApproval')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="pp-line">
                    <span className="mk-meta">{t('people.panel.access.disabledBody')}</span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => {
                        run(() => actions.enable(undefined), close);
                      }}
                    >
                      {t('people.panel.access.enable')}
                    </button>
                  </div>
                )
              ) : self ? (
                <Reason>{t('people.panel.access.self')}</Reason>
              ) : disablePending ? (
                <div className="pp-line">
                  <span className="badge badge-amber">
                    {t('people.panel.access.disablePending')}
                  </span>
                  <span className="mk-meta mono">{disablePending.change_id.slice(0, 8)}</span>
                </div>
              ) : open?.kind !== 'disable' ? (
                <div className="pp-line">
                  <span className="mk-meta">
                    {t('people.panel.access.disableBody')}
                    {admin ? t('people.panel.access.disableAdmin') : ''}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm mk-danger"
                    disabled={admin && fewAdmins}
                    title={admin && fewAdmins ? t('people.panel.access.disableLast') : undefined}
                    onClick={() => {
                      show({ kind: 'disable' });
                    }}
                  >
                    {t('people.panel.access.disableOpen')}
                  </button>
                </div>
              ) : (
                <div className="pp-form">
                  <ReasonBox
                    value={reason}
                    onChange={setReason}
                    placeholder={t('people.panel.access.disableReasonPlaceholder')}
                    label={t('people.panel.access.disableReasonLabel')}
                  />
                  <div className="pp-form-actions">
                    {cancel}
                    <button
                      type="button"
                      className="btn btn-sm mk-danger"
                      disabled={!reason.trim() || busy}
                      onClick={() => {
                        run(() => actions.disable(reason.trim()), close);
                      }}
                    >
                      {admin
                        ? t('people.panel.groups.sendToApproval')
                        : t('people.panel.access.disableSubmit')}
                    </button>
                  </div>
                </div>
              )}
            </section>

            <div className="pp-limits">
              <LockIcon size={12} />
              {t('people.panel.limits')}
            </div>
          </div>
        </aside>
      </div>
    </div>,
    document.body,
  );
}
