import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { GroupChips } from '../knowledge/parts';
import { SidePanel } from '../../components/SidePanel';
import {
  Check2Icon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GlobeIcon,
  InfoIcon,
  LockIcon,
  PlusIcon,
  UserIcon,
  WarnIcon,
  X2Icon,
} from '../../components/icons';
import { formatRelative } from '../../lib/format';
import {
  DEFAULT_SECRET_DAYS,
  REASON_MAX_LENGTH,
  SECRET_MAX_LENGTH,
  changeOf,
  dayInput,
  formErrors,
  formatDay,
  hasErrors,
  historyOf,
  personOf,
  rowsOf,
  sameGroups,
  toolCount,
  toolsOf,
  type FormErrors,
  type RemoteCatalog,
  type RemoteForm,
  type RemoteProfile,
  type Row,
} from './model';
import { DisableModal, RotateModal, type Act } from './modals';
import { RmBadges, RmCopy, RmField, RmStatus, RmTile, SecretAlert, SecretLine } from './parts';

type Mode =
  | null
  | { k: 'row'; key: string; sent?: boolean; reject?: boolean }
  | { k: 'form'; form: RemoteForm; row: Row | null };

/** The row a key names; once its request is decided, the registration it was on. */
function findRow(rows: readonly Row[], key: string): Row | null {
  return (
    rows.find((row) => row.key === key) ?? rows.find((row) => row.key === key.split(':')[0]) ?? null
  );
}

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mk-sec">
      <div className="mk-sec-t">{title.toLowerCase()}</div>
      {children}
    </section>
  );
}

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="mk-kv">
      <span>{k}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * Design `RemoteDetail`: the card of a profile in a drawer, its organizations and history, the
 * request in two steps and the decision on each row. What the drawer offers is UX: the API
 * authorizes each action (`ManageRemoteMcp`, `ApproveRemoteMcp`), checks that who asked does not
 * approve, and never returns the secret.
 */
export function RemoteDetail({
  profile,
  catalog,
  initialRow,
  isAdmin,
  meId,
  groups,
  onAct,
  onClose,
}: {
  profile: RemoteProfile;
  catalog: RemoteCatalog;
  initialRow: string | null;
  isAdmin: boolean;
  meId: string;
  /** Group ids of the registry (D26), `null` while they load or when they cannot be read. */
  groups: readonly string[] | null;
  onAct: Act;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>(initialRow ? { k: 'row', key: initialRow } : null);
  const [tried, setTried] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState('');
  const [modal, setModal] = useState<'rotate' | 'disable' | null>(null);

  const rows = rowsOf(catalog, profile.id);
  const history = historyOf(catalog, profile.id);
  const who = (id: string | null | undefined, email: string | null | undefined, you: string) => {
    const person = personOf(id, email, meId);
    return person === 'me' ? you : person;
  };

  const openForm = (base: Row | null, kind: RemoteForm['kind']) => {
    const source =
      kind === 'params'
        ? (base?.registration ?? null)
        : (base?.request ?? base?.registration ?? null);
    setMode({
      k: 'form',
      row: base,
      form: {
        kind,
        organization: base?.registration.organization ?? '',
        tenantId: '',
        clientId: '',
        secret: '',
        secretExpiresOn: dayInput(DEFAULT_SECRET_DAYS),
        toolsets: source ? [...source.toolsets] : profile.toolsets.map((toolset) => toolset.id),
        groups: source ? [...source.groups] : [],
      },
    });
    setTried(false);
    setFailure(null);
  };

  const back = () => {
    setMode(null);
    setFailure(null);
    setTried(false);
  };

  const run = async (action: Parameters<Act>[0], organization: string, after: () => void) => {
    setBusy(true);
    setFailure(null);
    const error = await onAct(action, { name: profile.name, organization });
    setBusy(false);
    if (error) setFailure(error);
    else after();
  };

  let body: ReactNode;
  let foot: ReactNode = null;
  let title = profile.name;

  if (mode?.k === 'form') {
    const { form } = mode;
    const errors: FormErrors = tried ? formErrors(form) : {};
    const err = (field: keyof FormErrors) =>
      errors[field]
        ? t(`remoteMcp.form.errors.${errors[field]}` as 'remoteMcp.form.errors.guid')
        : null;
    const set = (patch: Partial<RemoteForm>) => {
      setMode({ ...mode, form: { ...form, ...patch } });
    };
    const toggle = (id: string) => {
      set({
        toolsets: form.toolsets.includes(id)
          ? form.toolsets.filter((value) => value !== id)
          : [...form.toolsets, id],
      });
    };
    const fixed = form.kind !== 'enable';
    const replace = form.kind === 'replace_app';
    const scope = form.kind === 'params';
    const toolsetLabel = (id: string) =>
      profile.toolsets.find((toolset) => toolset.id === id)?.label ?? id;
    title = scope
      ? t('remoteMcp.detail.titleParams', { organization: form.organization })
      : replace
        ? t('remoteMcp.detail.titleReplace')
        : t('remoteMcp.detail.titleEnable', { name: profile.name });
    const submit = () => {
      setTried(true);
      setFailure(null);
      if (hasErrors(formErrors(form))) return;
      const base = mode.row;
      if (scope && base && sameGroups(form, base.registration)) {
        setFailure(t('remoteMcp.errors.no_change'));
        return;
      }
      const action: Parameters<Act>[0] =
        form.kind === 'enable' || !base
          ? { kind: 'request', profileId: profile.id, form }
          : {
              kind: scope ? 'params' : form.kind === 'replace_app' ? 'replace' : 'reenable',
              registration: base.registration,
              form,
            };
      void run(action, form.organization.trim(), () => {
        // The secret leaves the form state as soon as the API has it.
        setMode({
          k: 'row',
          key: base ? base.registration.id + ':' : `org:${form.organization.trim().toLowerCase()}`,
          sent: true,
        });
        setTried(false);
      });
    };
    body = (
      <>
        <div className="rm-steps" aria-label={t('remoteMcp.form.stepsLabel')}>
          <span className="is-on">{t('remoteMcp.form.step1')}</span>
          <span>{t('remoteMcp.form.step2')}</span>
        </div>
        {scope ? (
          <div className="mc-alert">
            <InfoIcon size={14} />
            <div>{t('remoteMcp.form.paramsNote')}</div>
          </div>
        ) : null}
        {replace ? (
          <>
            <div className="mc-alert amber">
              <WarnIcon size={14} />
              <div>
                <b>{t('remoteMcp.form.replaceReconnect')}</b>{' '}
                {t('remoteMcp.form.replaceReconnectWhy')}
              </div>
            </div>
            <div className="mc-alert">
              <InfoIcon size={14} />
              <div>{t('remoteMcp.form.replaceNote')}</div>
            </div>
          </>
        ) : null}
        <div className="rm-form">
          {scope ? (
            <Kv k={t('remoteMcp.row.organization')}>
              <span className="mono">
                {profile.host}/{form.organization}
              </span>
            </Kv>
          ) : (
            <>
              <RmField
                id="rf-org"
                label={t('remoteMcp.form.organization', { name: profile.name })}
                hint={t('remoteMcp.form.organizationHint')}
                error={err('organization')}
              >
                <div className="rm-prefix">
                  <span className="mono">{profile.host}/</span>
                  <input
                    id="rf-org"
                    className="input mono"
                    value={form.organization}
                    maxLength={49}
                    disabled={fixed}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => {
                      set({ organization: event.target.value });
                    }}
                    autoFocus={!fixed}
                  />
                </div>
              </RmField>
              <div className="rm-2col">
                <RmField id="rf-ten" label={t('remoteMcp.form.tenant')} error={err('tenantId')}>
                  <input
                    id="rf-ten"
                    className="input mono"
                    value={form.tenantId}
                    maxLength={36}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={t('remoteMcp.form.guidPlaceholder')}
                    onChange={(event) => {
                      set({ tenantId: event.target.value });
                    }}
                    autoFocus={fixed}
                  />
                </RmField>
                <RmField id="rf-cli" label={t('remoteMcp.form.client')} error={err('clientId')}>
                  <input
                    id="rf-cli"
                    className="input mono"
                    value={form.clientId}
                    maxLength={36}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={t('remoteMcp.form.guidPlaceholder')}
                    onChange={(event) => {
                      set({ clientId: event.target.value });
                    }}
                  />
                </RmField>
              </div>
              <div className="rm-2col">
                <RmField
                  id="rf-sec"
                  label={t('remoteMcp.form.secret')}
                  hint={t('remoteMcp.form.secretHint')}
                  error={err('secret')}
                >
                  {/* Write only: a password field, never persisted, sent once to the API. */}
                  <input
                    id="rf-sec"
                    className="input mono"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={SECRET_MAX_LENGTH}
                    value={form.secret}
                    onChange={(event) => {
                      set({ secret: event.target.value });
                    }}
                  />
                </RmField>
                <RmField
                  id="rf-exp"
                  label={t('remoteMcp.form.expiry')}
                  hint={t('remoteMcp.form.expiryHint')}
                  error={err('secretExpiresOn')}
                >
                  <input
                    id="rf-exp"
                    className="input"
                    type="date"
                    value={form.secretExpiresOn}
                    onChange={(event) => {
                      set({ secretExpiresOn: event.target.value });
                    }}
                  />
                </RmField>
              </div>
            </>
          )}
          {replace ? (
            <>
              <div className="rm-field">
                <span className="rm-label">{t('remoteMcp.form.toolsets')}</span>
                <div className="rm-sets">
                  {form.toolsets.map((id) => (
                    <span key={id} className="rm-set">
                      {toolsetLabel(id)}
                    </span>
                  ))}
                </div>
              </div>
              <div className="rm-field">
                <span className="rm-label">{t('remoteMcp.form.groupsShort')}</span>
                <div className="rm-sets">
                  {form.groups.map((group) => (
                    <span key={group} className="badge mono">
                      {group}
                    </span>
                  ))}
                </div>
                <div className="rm-hint">{t('remoteMcp.form.replaceGroupsHint')}</div>
              </div>
            </>
          ) : (
            <>
              <div className={errors.toolsets ? 'rm-field has-error' : 'rm-field'}>
                <span className="rm-label" id="rf-ts">
                  {t('remoteMcp.form.toolsets')}
                </span>
                <div className="rm-checks" role="group" aria-labelledby="rf-ts">
                  {profile.toolsets.map((toolset) => {
                    const on = form.toolsets.includes(toolset.id);
                    return (
                      <label key={toolset.id} className={on ? 'rm-check is-on' : 'rm-check'}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            toggle(toolset.id);
                          }}
                        />
                        <span>{toolset.label}</span>
                        <span className="mk-meta">{toolset.tools.length}</span>
                      </label>
                    );
                  })}
                </div>
                {errors.toolsets ? (
                  <div className="rm-err" role="alert">
                    {err('toolsets')}
                  </div>
                ) : (
                  <div className="rm-hint">{t('remoteMcp.form.toolsetsHint')}</div>
                )}
              </div>
              <div className={errors.groups ? 'rm-field has-error' : 'rm-field'}>
                <span className="rm-label" id="rf-gr">
                  {t('remoteMcp.form.groups')}
                </span>
                <div className="rm-chips" aria-labelledby="rf-gr">
                  <GroupChips
                    options={groups ?? []}
                    value={form.groups}
                    onChange={(next) => {
                      set({ groups: [...next] });
                    }}
                  />
                </div>
                {errors.groups ? (
                  <div className="rm-err" role="alert">
                    {err('groups')}
                  </div>
                ) : (
                  <div className="rm-hint">{t('remoteMcp.form.groupsHint')}</div>
                )}
              </div>
            </>
          )}
        </div>
      </>
    );
    foot = (
      <>
        {failure ? (
          <div className="g-err mb-2.5" role="alert">
            {failure}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={submit}>
            {t('remoteMcp.form.send')}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={back}>
            {t('remoteMcp.form.cancel')}
          </button>
        </div>
      </>
    );
  } else if (mode?.k === 'row' && resolveSent(rows, mode.key)) {
    const current = resolveSent(rows, mode.key) as Row;
    const { registration: reg, request } = current;
    const facts = request ?? reg;
    const pending = current.status === 'pending' && request !== null;
    const own = pending && request.own;
    const asked = who(facts.requested_by, facts.requested_by_email, t('remoteMcp.requests.you'));
    title = t('remoteMcp.detail.titleRow', { name: profile.name, organization: reg.organization });
    const approver = who(reg.approved_by, reg.approved_by_email, t('remoteMcp.requests.you'));
    const openChange = rows.find(
      (other) => other.registration.id === reg.id && other.request !== null,
    )?.request;
    const changeOpen = Boolean(openChange);
    const scopeReq = pending && request.kind === 'params';
    const replaceReq = pending && request.kind === 'replace_app';
    const toolsetLabel = (id: string) =>
      profile.toolsets.find((toolset) => toolset.id === id)?.label ?? id;
    const diffBadges = (
      before: readonly string[],
      after: readonly string[],
      label: (id: string) => string,
      mono: boolean,
    ) =>
      changeOf(before, after).map(({ id, change }) => (
        <span
          key={id}
          className={[
            'badge',
            mono ? 'mono' : '',
            change === 'add' ? 'badge-green' : change === 'remove' ? 'badge-red rm-del' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          title={
            change === 'add'
              ? t('remoteMcp.row.added')
              : change === 'remove'
                ? t('remoteMcp.row.removed')
                : undefined
          }
        >
          {change === 'add' ? '+ ' : change === 'remove' ? '− ' : ''}
          {label(id)}
        </span>
      ));
    body = scopeReq ? (
      <>
        {mode.sent ? (
          <div className="mc-alert">
            <Check2Icon size={14} className="text-ok" />
            <div>
              <b>{t('remoteMcp.row.sentTitle')}</b> {t('remoteMcp.row.approverOther')}
            </div>
          </div>
        ) : null}
        <div className="rm-steps" aria-label={t('remoteMcp.form.stepsLabel2')}>
          <span className="is-done">{t('remoteMcp.row.stepAsked', { by: asked ?? '' })}</span>
          <span className="is-on">{t('remoteMcp.row.stepApprove')}</span>
        </div>
        <div className="mc-alert">
          <InfoIcon size={14} />
          <div>
            {t('remoteMcp.row.paramsBefore', { name: profile.name })}
            <span className="mono">{reg.organization}</span>
            {t('remoteMcp.row.paramsAfter')}
          </div>
        </div>
        <Sec title={t('remoteMcp.row.changes')}>
          <Kv k={t('remoteMcp.row.toolsets')}>
            <span className="rm-sets justify-end">
              {diffBadges(
                request.previous_toolsets ?? reg.toolsets,
                request.toolsets,
                toolsetLabel,
                false,
              )}
            </span>
          </Kv>
          <Kv k={t('remoteMcp.row.groups')}>
            <span className="rm-sets justify-end">
              {diffBadges(request.previous_groups ?? reg.groups, request.groups, (id) => id, true)}
            </span>
          </Kv>
          {asked ? (
            <Kv k={t('remoteMcp.row.asked')}>
              {personOf(request.requested_by, request.requested_by_email, meId) === 'me'
                ? t('remoteMcp.row.you')
                : asked}
              {` · ${formatRelative(request.created_at)}`}
            </Kv>
          ) : null}
        </Sec>
      </>
    ) : (
      <>
        {mode.sent ? (
          <div className="mc-alert">
            <Check2Icon size={14} className="text-ok" />
            <div>
              <b>{t('remoteMcp.row.sentTitle')}</b> {t('remoteMcp.row.sentBody')}
            </div>
          </div>
        ) : null}
        {pending ? (
          <div className="rm-steps" aria-label={t('remoteMcp.form.stepsLabel2')}>
            <span className="is-done">{t('remoteMcp.row.stepAsked', { by: asked ?? '' })}</span>
            <span className="is-on">{t('remoteMcp.row.stepApprove')}</span>
          </div>
        ) : null}
        {replaceReq ? (
          <div className="mc-alert amber">
            <WarnIcon size={14} />
            <div>
              <b>{t('remoteMcp.row.replaceReconnect', { name: profile.name })}</b>
            </div>
          </div>
        ) : null}
        {pending && request.callback_url ? (
          <div className="rm-redirect">
            <RmCopy value={request.callback_url} label={t('remoteMcp.row.redirect')} />
            <div className="rm-hint">
              {t('remoteMcp.row.redirectHintA')}
              <b>{t('remoteMcp.row.redirectHintWeb')}</b>
              {t('remoteMcp.row.redirectHintB')}
            </div>
          </div>
        ) : null}
        {current.status === 'active' || current.status === 'secretExpired' ? (
          <SecretAlert
            registration={reg}
            profile={profile}
            onRotate={
              isAdmin
                ? () => {
                    setModal('rotate');
                  }
                : null
            }
          />
        ) : null}
        {current.status === 'creating' ? (
          <div className="mc-alert" role="status">
            <span className="g-spin" aria-hidden="true" />
            <div>
              <b>{t('remoteMcp.row.creatingTitle')}</b>{' '}
              {approver
                ? t('remoteMcp.row.creatingBody', { by: approver, name: profile.name })
                : t('remoteMcp.row.creatingBodyNoApprover', { name: profile.name })}
            </div>
          </div>
        ) : null}
        {current.status === 'failed' ? (
          <div className="mc-alert red" role="alert">
            <X2Icon size={14} />
            <div>
              <b>{t('remoteMcp.row.failedTitle', { name: profile.name })}</b>
              <div>{t('remoteMcp.row.failedBody')}</div>
            </div>
          </div>
        ) : null}
        {current.status === 'disabled' ? (
          <div className="mc-alert">
            <InfoIcon size={14} />
            <div>
              {t('remoteMcp.row.disabledBy', {
                by: who(reg.disabled_by, null, t('remoteMcp.requests.you')) ?? '',
                when: reg.disabled_at ? formatRelative(reg.disabled_at) : '',
              })}
              {reg.reason ? `: «${reg.reason}»` : null}
              <div className="mk-meta mt-[3px]">{t('remoteMcp.row.disabledDeleted')}</div>
            </div>
          </div>
        ) : null}
        <Sec title={t('remoteMcp.row.section')}>
          <Kv k={t('remoteMcp.row.organization')}>
            <span className="mono">
              {profile.host}/{facts.organization}
            </span>
          </Kv>
          {facts.tenant_id ? (
            <Kv k={t('remoteMcp.row.tenant')}>
              <span className="mono rm-wrap">{facts.tenant_id}</span>
            </Kv>
          ) : null}
          {facts.client_id ? (
            <Kv k={t('remoteMcp.row.client')}>
              <span className="mono rm-wrap">{facts.client_id}</span>
            </Kv>
          ) : null}
          <Kv k={t('remoteMcp.row.secret')}>
            {current.status === 'disabled' && !reg.secret_expires_on ? (
              <span className="mk-meta">{t('remoteMcp.row.secretDeleted')}</span>
            ) : (
              <span className="flex items-center gap-2">
                <LockIcon size={11} /> {t('remoteMcp.row.secretStored')}
              </span>
            )}
          </Kv>
          {pending ? (
            request.secret_expires_on ? (
              <Kv k={t('remoteMcp.row.secretExpiry')}>{formatDay(request.secret_expires_on)}</Kv>
            ) : null
          ) : reg.secret_expires_on ? (
            <Kv k={t('remoteMcp.row.secretExpiry')}>
              <SecretLine registration={reg} />
            </Kv>
          ) : null}
          <Kv k={t('remoteMcp.row.toolsets')}>
            <span className="rm-sets justify-end">
              {toolsOf(profile, facts.toolsets).map((toolset) => (
                <span key={toolset.id} className="rm-set">
                  {toolset.label}
                </span>
              ))}
            </span>
          </Kv>
          <Kv k={t('remoteMcp.row.groups')}>
            <span className="rm-sets justify-end">
              {facts.groups.map((group) => (
                <span key={group} className="badge mono">
                  {group}
                </span>
              ))}
            </span>
          </Kv>
          {asked ? (
            <Kv k={t('remoteMcp.row.asked')}>
              {personOf(facts.requested_by, facts.requested_by_email, meId) === 'me'
                ? t('remoteMcp.row.you')
                : asked}
              {request ? ` · ${formatRelative(request.created_at)}` : null}
            </Kv>
          ) : null}
          {!pending && approver ? (
            <Kv k={t('remoteMcp.row.approved')}>
              {personOf(reg.approved_by, reg.approved_by_email, meId) === 'me'
                ? t('remoteMcp.row.you')
                : approver}
            </Kv>
          ) : null}
        </Sec>
        {!pending && current.status !== 'pending' && reg.status === 'active' && reg.callback_url ? (
          <Sec title={t('remoteMcp.row.redirect')}>
            <RmCopy value={reg.callback_url} label={t('remoteMcp.row.redirectConfigured')} />
          </Sec>
        ) : null}
      </>
    );
    const errorLine = failure ? (
      <div className="g-err mb-2.5" role="alert">
        {failure}
      </div>
    ) : null;
    if (!isAdmin) {
      foot = (
        <div className="ap-reason">
          <LockIcon size={12} /> {t('remoteMcp.detail.adminsOnlyRow')}
        </div>
      );
    } else if (pending && mode.reject) {
      foot = (
        <div className="grid gap-2">
          <label htmlFor="rm-why" className="text-[12.5px] font-medium">
            {t('remoteMcp.row.rejectReason')}
          </label>
          <textarea
            id="rm-why"
            className="input"
            rows={2}
            maxLength={REASON_MAX_LENGTH}
            value={why}
            onChange={(event) => {
              setWhy(event.target.value);
            }}
            autoFocus
            style={tried && !why.trim() ? { borderColor: 'var(--red)' } : undefined}
          />
          {tried && !why.trim() ? (
            <div className="rm-err">{t('remoteMcp.row.reasonRequired')}</div>
          ) : null}
          <div className="rm-hint">{t('remoteMcp.row.rejectHint')}</div>
          {errorLine}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-sm mk-danger"
              disabled={busy}
              onClick={() => {
                setTried(true);
                if (!why.trim()) return;
                void run(
                  { kind: 'reject', registration: reg, request, reason: why.trim() },
                  reg.organization,
                  () => {
                    setMode(null);
                    setWhy('');
                    setTried(false);
                  },
                );
              }}
            >
              {t('remoteMcp.row.reject')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => {
                setMode({ ...mode, reject: false });
                setTried(false);
              }}
            >
              {t('remoteMcp.row.cancel')}
            </button>
          </div>
        </div>
      );
    } else if (pending) {
      foot = (
        <>
          {errorLine}
          {own ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="ap-reason">
                <LockIcon size={12} /> {t('remoteMcp.row.approverOther')}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => {
                  void run(
                    { kind: 'withdraw', registration: reg, request },
                    reg.organization,
                    () => {
                      setMode(null);
                    },
                  );
                }}
              >
                {t('remoteMcp.row.withdraw')}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy}
                onClick={() => {
                  void run(
                    { kind: 'approve', registration: reg, request },
                    reg.organization,
                    () => {
                      setMode({ k: 'row', key: reg.id });
                    },
                  );
                }}
              >
                <CheckIcon size={12} /> {t('remoteMcp.row.approve')}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => {
                  setMode({ ...mode, reject: true });
                }}
              >
                {t('remoteMcp.row.reject')}
              </button>
            </div>
          )}
        </>
      );
    } else if (current.status === 'creating') {
      foot = (
        <div className="ap-reason">
          <span className="g-spin" aria-hidden="true" /> {t('remoteMcp.row.creatingFoot')}
        </div>
      );
    } else if (current.status === 'active' || current.status === 'secretExpired') {
      foot = (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setModal('rotate');
            }}
          >
            {t('remoteMcp.row.rotate')}
          </button>
          {/* The API keeps one pending request per registration (pending_exists). */}
          <button
            type="button"
            className="btn btn-sm"
            disabled={changeOpen}
            title={
              changeOpen
                ? openChange?.kind === 'params'
                  ? t('remoteMcp.row.paramsBusy')
                  : t('remoteMcp.row.replaceBusy')
                : undefined
            }
            onClick={() => {
              openForm(current, 'params');
            }}
          >
            {t('remoteMcp.row.changeGroups')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={changeOpen}
            title={
              changeOpen
                ? openChange?.kind === 'params'
                  ? t('remoteMcp.row.paramsBusy')
                  : t('remoteMcp.row.replaceBusy')
                : undefined
            }
            onClick={() => {
              openForm(current, 'replace_app');
            }}
          >
            {t('remoteMcp.row.replace')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setModal('disable');
            }}
          >
            {t('remoteMcp.row.disable')}
          </button>
        </div>
      );
    } else if (current.status === 'failed' || current.status === 'disabled') {
      foot = changeOpen ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              openForm(current, 'reenable');
            }}
          >
            {t('remoteMcp.row.askAgain')}
          </button>
          {current.status === 'disabled' ? (
            <span className="mk-meta">{t('remoteMcp.row.askAgainHint')}</span>
          ) : null}
        </div>
      );
    }
  } else {
    body = (
      <>
        <div className="mc-alert amber">
          <GlobeIcon size={14} />
          <div>
            <b>{t('remoteMcp.detail.dataLeavesTitle')}</b>{' '}
            {t('remoteMcp.detail.dataLeavesBody', { operator: profile.operator })}
          </div>
        </div>
        <div className="mc-alert">
          <UserIcon size={14} />
          <div>{t('remoteMcp.detail.eachPerson', { idp: profile.provider })}</div>
        </div>
        <Sec title={t('remoteMcp.detail.organizations', { count: rows.length })}>
          {rows.length ? (
            rows.map((item) => (
              <button
                key={item.key}
                type="button"
                className="mk-line rm-regrow flex items-center justify-between"
                onClick={() => {
                  setMode({ k: 'row', key: item.key });
                  setFailure(null);
                }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="mono text-[12.5px]">{item.registration.organization}</span>
                  {item.request && item.registration.status !== 'pending' ? (
                    <span className="badge">
                      {item.request.kind === 'params'
                        ? t('remoteMcp.detail.paramsBadge')
                        : t('remoteMcp.detail.changeBadge')}
                    </span>
                  ) : null}
                  <span className="mk-meta">
                    {t('remoteMcp.detail.rowMeta', {
                      toolsets: (item.request ?? item.registration).toolsets.length,
                      groups: t('remoteMcp.card.groups', {
                        count: (item.request ?? item.registration).groups.length,
                      }),
                    })}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <RmStatus status={item.status} />
                  <ChevronRightIcon size={12} />
                </span>
              </button>
            ))
          ) : (
            <div className="mk-meta">{t('remoteMcp.detail.noOrganizations')}</div>
          )}
        </Sec>
        {history.length > 0 ? (
          <Sec title={t('remoteMcp.detail.history', { count: history.length })}>
            {history.map(({ request }) => {
              const by = who(
                request.requested_by,
                request.requested_by_email,
                t('remoteMcp.detail.you'),
              );
              const decided = who(
                request.decided_by,
                request.decided_by_email,
                t('remoteMcp.detail.you'),
              );
              const outcome =
                request.status === 'withdrawn'
                  ? request.decided_by === request.requested_by
                    ? t('remoteMcp.detail.historyWithdrawnBySelf')
                    : t('remoteMcp.detail.historyWithdrawnBy', { by: decided ?? '' })
                  : t('remoteMcp.detail.historyRejectedBy', { by: decided ?? '' });
              return (
                <div key={request.id} className="mk-line rm-hist">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="mono text-[12.5px]">{request.organization}</span>
                      <RmStatus
                        status={request.status === 'withdrawn' ? 'withdrawn' : 'rejected'}
                      />
                    </span>
                    <span className="mk-meta">
                      {formatRelative(request.decided_at ?? request.created_at)}
                    </span>
                  </div>
                  <div className="mk-meta">
                    {t('remoteMcp.detail.historyAsked', { by: by ?? '' })} · {outcome}
                    {request.kind === 'params' ? t('remoteMcp.detail.historyParams') : ''} ·{' '}
                    {t('remoteMcp.detail.historyMeta', {
                      toolsets: request.toolsets.length,
                      groups: request.groups.join(', '),
                    })}
                  </div>
                  {request.decision_reason ? (
                    <div className="rm-hist-why">«{request.decision_reason}»</div>
                  ) : null}
                </div>
              );
            })}
            <div className="mk-meta mt-1.5">{t('remoteMcp.detail.historyNote')}</div>
          </Sec>
        ) : null}
        <Sec title={t('remoteMcp.detail.tools', { count: toolCount(profile) })}>
          {profile.toolsets.map((toolset) => (
            <div key={toolset.id} className="rm-tset">
              <div className="rm-tset-h">{toolset.label}</div>
              {toolset.tools.map((name) => (
                <div key={name} className="mk-line flex items-center justify-between">
                  <span className="mono text-[12.5px] font-semibold">{name}</span>
                  <span className="badge">{t('remoteMcp.detail.read')}</span>
                </div>
              ))}
            </div>
          ))}
          <div className="mk-meta mt-1.5">{t('remoteMcp.detail.noWrite')}</div>
        </Sec>
        <Sec title={t('remoteMcp.detail.permissions', { idp: profile.provider })}>
          {/* What the signed profile asks for, grouped by resource (design round 24). */}
          {permissionsByResource(profile).map(([resource, permissions]) => (
            <div key={resource} className="mk-line flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] font-semibold">{resource}</span>
              {permissions.map((permission) => (
                <span key={permission} className="badge mono">
                  {permission}
                </span>
              ))}
            </div>
          ))}
          <div className="mk-meta mt-1.5">{t('remoteMcp.detail.permissionsNote')}</div>
        </Sec>
        <Sec title={t('remoteMcp.detail.host')}>
          <div className="flex items-center gap-2">
            <code className="mono rm-host">{profile.host}</code>
            <span className="mk-meta">{t('remoteMcp.detail.hostFixed')}</span>
          </div>
        </Sec>
      </>
    );
    foot = isAdmin ? (
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => {
          openForm(null, 'enable');
        }}
      >
        <PlusIcon size={12} /> {t('remoteMcp.detail.enableFor')}
      </button>
    ) : (
      <div className="ap-reason">
        <LockIcon size={12} /> {t('remoteMcp.detail.adminsOnly')}
      </div>
    );
  }

  const shown = mode?.k === 'row' ? resolveSent(rows, mode.key) : null;
  return (
    <>
      <SidePanel
        title={title}
        width={540}
        lead={
          <>
            {mode ? (
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={t('remoteMcp.detail.back')}
                onClick={back}
              >
                <ChevronLeftIcon size={14} />
              </button>
            ) : null}
            <RmTile profile={profile} lg />
          </>
        }
        meta={
          <span className="flex flex-wrap items-center gap-2">
            {shown ? <RmStatus status={shown.status} /> : null}
            <RmBadges profile={profile} compact />
            <span className="mk-meta">
              {t('remoteMcp.operatedBy', { operator: profile.operator })} ·{' '}
              {t('remoteMcp.profileVersion', { version: profile.version })}
            </span>
          </span>
        }
        footer={foot}
        onClose={onClose}
      >
        <div className="grid gap-3.5">{body}</div>
      </SidePanel>
      {modal && shown ? (
        modal === 'rotate' ? (
          <RotateModal
            registration={shown.registration}
            profile={profile}
            onAct={onAct}
            onClose={() => {
              setModal(null);
            }}
          />
        ) : (
          <DisableModal
            registration={shown.registration}
            profile={profile}
            onAct={onAct}
            onClose={() => {
              setModal(null);
            }}
          />
        )
      ) : null}
    </>
  );
}

/**
 * The row of a key. After sending a request the key is `<registration>:` (the request id is
 * not known until the catalog comes back) or `org:<organization>` for a new registration.
 */
function resolveSent(rows: readonly Row[], key: string): Row | null {
  if (key.startsWith('org:')) {
    const organization = key.slice(4);
    return (
      rows.find(
        (row) =>
          row.request !== null && row.registration.organization.toLowerCase() === organization,
      ) ?? null
    );
  }
  if (key.endsWith(':')) {
    const id = key.slice(0, -1);
    return (
      rows.find((row) => row.registration.id === id && row.request !== null) ??
      rows.find((row) => row.registration.id === id) ??
      null
    );
  }
  return findRow(rows, key);
}

/** The profile's permissions by resource, in its order («Azure DevOps MCP», «Microsoft Entra»). */
function permissionsByResource(profile: RemoteProfile): [string, string[]][] {
  const out = new Map<string, string[]>();
  for (const { resource, permission } of profile.permissions) {
    out.set(resource, [...(out.get(resource) ?? []), permission]);
  }
  return [...out];
}
