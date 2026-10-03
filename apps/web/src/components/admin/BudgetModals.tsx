import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { parseMoney, type Budgets, type UserBudget } from '../../api/adminSchemas';
import type { DialogError } from './ChangeModals';
import { pctOf, shortId, toInput, toNumber, usd } from './govFormat';
import { Banner, GovModal, MoneyInput, UsagePreview } from './govKit';

/** Result of a budget write, decided by the page from the API answer. */
export type SaveResult =
  { kind: 'ok' } | { kind: 'conflict'; fresh: Budgets } | { kind: 'error'; error: DialogError };

function ConflictBanner() {
  const { t } = useTranslation();
  return (
    <Banner tone="warn" title={t('budgets.conflict.title')}>
      {t('budgets.conflict.body')}
    </Banner>
  );
}

interface DefaultsProps {
  data: Budgets;
  onClose: () => void;
  onSave: (values: { user: string; agent: string }) => Promise<SaveResult>;
}

/** Default monthly limits per user and per agent (design `DefaultsModal`). */
export function DefaultsModal({ data, onClose, onSave }: DefaultsProps) {
  const { t } = useTranslation();
  const id = useId();
  const [current, setCurrent] = useState(data);
  const [user, setUser] = useState(() => toInput(data.defaults.user_monthly_usd));
  const [agent, setAgent] = useState(() => toInput(data.defaults.agent_monthly_usd));
  const [tried, setTried] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<DialogError | null>(null);
  const [saving, setSaving] = useState(false);
  const parsedUser = parseMoney(user);
  const parsedAgent = parseMoney(agent);
  const onDefault = current.users.filter((item) => !item.override);
  const newUserLimit = 'value' in parsedUser ? Number(parsedUser.value) : null;
  const wouldBlock =
    newUserLimit === null
      ? 0
      : onDefault.filter((item) => toNumber(item.spent_usd) >= newUserLimit).length;

  const save = async () => {
    setTried(true);
    if (!('value' in parsedUser) || !('value' in parsedAgent)) return;
    setSaving(true);
    setError(null);
    const result = await onSave({ user: parsedUser.value, agent: parsedAgent.value });
    setSaving(false);
    if (result.kind === 'conflict') {
      // TM-A4: someone else changed the budgets; show their values instead of overwriting.
      setCurrent(result.fresh);
      setUser(toInput(result.fresh.defaults.user_monthly_usd));
      setAgent(toInput(result.fresh.defaults.agent_monthly_usd));
      setConflict(true);
      setTried(false);
    } else if (result.kind === 'error') {
      setError(result.error);
    }
  };

  return (
    <GovModal
      title={t('budgets.defaultsModal.title')}
      sub={t('budgets.defaultsModal.sub', { period: current.period })}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button type="button" className="btn btn-sm" disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </>
      }
    >
      {conflict && <ConflictBanner />}
      {error && (
        <Banner tone="error" title={error.title}>
          {error.body}
        </Banner>
      )}
      <MoneyInput
        id={`${id}-user`}
        label={t('budgets.defaultsModal.user')}
        value={user}
        onChange={setUser}
        autoFocus
        disabled={saving}
        error={tried && 'error' in parsedUser ? t(parsedUser.error) : undefined}
        hint={t('budgets.defaultsModal.userHint', { count: onDefault.length })}
      />
      {wouldBlock > 0 && (
        <Banner tone="warn">{t('budgets.defaultsModal.wouldBlock', { count: wouldBlock })}</Banner>
      )}
      <MoneyInput
        id={`${id}-agent`}
        label={t('budgets.defaultsModal.agent')}
        value={agent}
        onChange={setAgent}
        disabled={saving}
        error={tried && 'error' in parsedAgent ? t(parsedAgent.error) : undefined}
        hint={t('budgets.defaultsModal.agentHint')}
      />
      <div className="g-hint">{t('gov.money.rule')}</div>
    </GovModal>
  );
}

interface UserProps {
  data: Budgets;
  user: UserBudget;
  onClose: () => void;
  /** `null` goes back to the default limit. */
  onSave: (limit: string | null) => Promise<SaveResult>;
}

/** A user's own limit or the default, with the resulting usage preview (design `UserModal`). */
export function UserBudgetModal({ data, user, onClose, onSave }: UserProps) {
  const { t } = useTranslation();
  const id = useId();
  const [current, setCurrent] = useState(data);
  const [mode, setMode] = useState<'default' | 'own'>(user.override ? 'own' : 'default');
  const [value, setValue] = useState(() =>
    toInput(user.override ? user.limit_usd : data.defaults.user_monthly_usd),
  );
  const [tried, setTried] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<DialogError | null>(null);
  const [saving, setSaving] = useState(false);
  const row = current.users.find((item) => item.user_id === user.user_id) ?? user;
  const label = row.email ?? shortId(row.user_id);
  const parsed = parseMoney(value);
  const limit =
    mode === 'default'
      ? toNumber(current.defaults.user_monthly_usd)
      : 'value' in parsed
        ? Number(parsed.value)
        : null;
  const percent = limit ? pctOf(toNumber(row.spent_usd), limit) : null;

  const save = async () => {
    setTried(true);
    if (mode === 'own' && !('value' in parsed)) return;
    setSaving(true);
    setError(null);
    const result = await onSave(mode === 'default' || !('value' in parsed) ? null : parsed.value);
    setSaving(false);
    if (result.kind === 'conflict') {
      const fresh = result.fresh.users.find((item) => item.user_id === user.user_id);
      setCurrent(result.fresh);
      if (fresh) {
        setMode(fresh.override ? 'own' : 'default');
        setValue(
          toInput(fresh.override ? fresh.limit_usd : result.fresh.defaults.user_monthly_usd),
        );
      }
      setConflict(true);
      setTried(false);
    } else if (result.kind === 'error') {
      setError(result.error);
    }
  };

  return (
    <GovModal
      title={t('budgets.userModal.title', { name: label })}
      sub={t('budgets.userModal.sub', { period: current.period, spent: usd(row.spent_usd) })}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button type="button" className="btn btn-sm" disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </>
      }
    >
      {conflict && <ConflictBanner />}
      {error && (
        <Banner tone="error" title={error.title}>
          {error.body}
        </Banner>
      )}
      <fieldset className="g-radios">
        <legend>{t('budgets.userModal.legend')}</legend>
        <label className={mode === 'default' ? 'g-radio is-on' : 'g-radio'}>
          <input
            type="radio"
            name={`${id}-mode`}
            checked={mode === 'default'}
            disabled={saving}
            onChange={() => {
              setMode('default');
            }}
          />
          <span>
            <span className="g-radio-t">{t('budgets.userModal.useDefault')}</span>
            <span className="g-sub">
              {t('budgets.userModal.useDefaultSub', {
                amount: usd(current.defaults.user_monthly_usd),
              })}
            </span>
          </span>
        </label>
        <label className={mode === 'own' ? 'g-radio is-on' : 'g-radio'}>
          <input
            type="radio"
            name={`${id}-mode`}
            checked={mode === 'own'}
            disabled={saving}
            onChange={() => {
              setMode('own');
            }}
          />
          <span>
            <span className="g-radio-t">{t('budgets.userModal.own')}</span>
            <span className="g-sub">{t('budgets.userModal.ownSub')}</span>
          </span>
        </label>
      </fieldset>
      {mode === 'own' && (
        <MoneyInput
          id={`${id}-own`}
          label={t('budgets.userModal.amount')}
          value={value}
          onChange={setValue}
          disabled={saving}
          error={tried && 'error' in parsed ? t(parsed.error) : undefined}
          hint={t('gov.money.rule')}
        />
      )}
      {percent !== null && (
        <UsagePreview percent={percent}>
          {percent >= 100 && <div className="g-sub mt-2">{t('budgets.userModal.blocked')}</div>}
        </UsagePreview>
      )}
    </GovModal>
  );
}
