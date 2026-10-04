import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GovModal } from '../../components/admin/govKit';
import { CheckIcon } from '../../components/icons';
import type { InviteServerError } from './errors';
import { ADMIN_GROUP, inviteError, isExternal, isSensitive, type GroupOption } from './model';

interface Props {
  /** Groups already chosen: `mango-admin` when the first-day card invites the second admin. */
  preset: readonly string[];
  /** Enabled administrators, as the directory counted them. */
  admins: number;
  options: readonly GroupOption[];
  /** Sign-up domains of the installation (public configuration). */
  domains: readonly string[];
  onClose: () => void;
  /** Resolves to `null` when invited, to the refusal otherwise (`failed`: the generic one). */
  onInvite: (email: string, groups: string[]) => Promise<InviteServerError | 'failed' | null>;
}

/**
 * Invites a person by email (design `InviteModal`). The checks here only spare a round trip for
 * an empty or malformed address: the API refuses public mail providers (and audits the refusal)
 * and the sensitive groups, and decides whether naming the second administrator is the
 * bootstrap (REACT-AUTHZ-001).
 */
export function InviteModal({ preset, admins, options, domains, onClose, onInvite }: Props) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [groups, setGroups] = useState<readonly string[]>(preset);
  const [tried, setTried] = useState(false);
  const [refused, setRefused] = useState<InviteServerError | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);

  const address = email.trim().toLowerCase();
  const onlyAdmin = admins === 1;
  const local = inviteError(address);
  // A malformed address stays on the field; the other refusals are the answer to the submit.
  const shown = tried ? (local ?? (refused === 'format' ? refused : null)) : null;
  const pickable = options.filter(
    (group) => !isSensitive(group.id) || (group.id === ADMIN_GROUP && onlyAdmin),
  );

  const submit = () => {
    setTried(true);
    setRefused(null);
    if (local || busy) return;
    setBusy(true);
    void onInvite(address, [...groups])
      .then((result) => {
        if (result === null) onClose();
        else setRefused(result);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <GovModal
      title={
        preset.includes(ADMIN_GROUP)
          ? t('people.inviteModal.titleAdmin')
          : t('people.inviteModal.title')
      }
      sub={t('people.inviteModal.sub')}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onClose}>
            {t('people.inviteModal.cancel')}
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={submit}>
            {busy ? t('people.inviteModal.sending') : t('people.inviteModal.submit')}
          </button>
        </>
      }
    >
      <div className="g-field">
        <label htmlFor="pp-inv">{t('people.inviteModal.email')}</label>
        <input
          id="pp-inv"
          className={shown ? 'input has-error' : 'input'}
          type="email"
          autoComplete="off"
          spellCheck={false}
          maxLength={254}
          data-autofocus=""
          value={email}
          aria-invalid={shown ? true : undefined}
          aria-describedby="pp-inv-h"
          placeholder={t('people.inviteModal.emailPlaceholder', { domain: domains[0] ?? '' })}
          onChange={(event) => {
            setEmail(event.target.value);
            setRefused(null);
          }}
        />
        {shown ? (
          <div id="pp-inv-h" className="g-err" role="alert">
            {t(`people.inviteModal.errors.${shown}`)}
          </div>
        ) : (
          <div id="pp-inv-h" className="g-hint">
            {local === null && isExternal(address, domains)
              ? t('people.inviteModal.external')
              : t('people.inviteModal.domains', { domains: domains.join(', ') })}
          </div>
        )}
      </div>
      <div className="g-field">
        <span className="g-label" id="pp-inv-groups">
          {t('people.inviteModal.groups')}{' '}
          <span className="pp-optional">{t('people.inviteModal.optional')}</span>
        </span>
        <div className="pp-invite-groups" role="group" aria-labelledby="pp-inv-groups">
          {pickable.map((group) => {
            const on = groups.includes(group.id);
            return (
              <button
                key={group.id}
                type="button"
                className={on ? 'ab-chip is-on' : 'ab-chip'}
                aria-pressed={on}
                title={group.description || undefined}
                onClick={() => {
                  setGroups((current) =>
                    current.includes(group.id)
                      ? current.filter((other) => other !== group.id)
                      : [...current, group.id],
                  );
                }}
              >
                {on ? <CheckIcon size={10} /> : null}
                <span className="mono">{group.id}</span>
              </button>
            );
          })}
        </div>
        <div className="g-hint">
          {groups.length === 0 ? t('people.inviteModal.noGroups') : ''}
          {onlyAdmin && groups.includes(ADMIN_GROUP)
            ? t('people.inviteModal.bootstrap')
            : t('people.inviteModal.sensitiveLater')}
        </div>
      </div>
      {refused !== null && refused !== 'format' ? (
        <div className="g-err" role="alert">
          {refused === 'failed'
            ? t('people.inviteModal.failed')
            : t(`people.inviteModal.errors.${refused}`)}
        </div>
      ) : null}
    </GovModal>
  );
}
