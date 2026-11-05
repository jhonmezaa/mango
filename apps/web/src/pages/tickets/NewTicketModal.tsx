import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { Agent } from '../../agents/agents';
import { CloseIcon } from '../../components/icons';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import {
  CHOSEN_STATUSES,
  MAX_DESCRIPTION,
  MAX_TITLE,
  PRIORITIES,
  type ChosenStatus,
  type Priority,
} from './model';

export interface NewTicket {
  title: string;
  description: string;
  agentId: string | null;
  priority: Priority;
  status: ChosenStatus;
  assignToMe: boolean;
}

function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="tk-field">
      <div className="tk-field-h">
        <label htmlFor={htmlFor}>{label}</label>
        {hint ? <span className="tk-field-hint">{hint}</span> : null}
      </div>
      {children}
      {error ? (
        <div className="tk-field-err" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Design `NewTicketModal`. The agent is optional: naming one shares the ticket with whoever may
 * use it (the API checks UseAgent), and it does not put the agent to work. A new ticket can only
 * be assigned to the person who creates it: nobody else takes part yet (D112).
 */
export function NewTicketModal({
  agents,
  initialStatus,
  busy,
  error,
  onClose,
  onCreate,
}: {
  /** The agents the person may use now (published). */
  agents: readonly Agent[];
  initialStatus: ChosenStatus;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (ticket: NewTicket) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [priority, setPriority] = useState<Priority>('medium');
  const [status, setStatus] = useState<ChosenStatus>(initialStatus);
  const [assignToMe, setAssignToMe] = useState(false);
  const [tried, setTried] = useState(false);
  const close = () => {
    if (!busy) onClose();
  };
  const ref = useFocusTrap<HTMLFormElement>(true, close);
  const missing = tried && !title.trim();

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setTried(true);
    if (!title.trim() || busy) return;
    onCreate({
      title: title.trim(),
      description: description.trim(),
      agentId: agentId || null,
      priority,
      status,
      assignToMe,
    });
  };

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        ref={ref}
        className="card tk-new"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        aria-describedby={`${id}-d`}
        onSubmit={submit}
        noValidate
      >
        <div className="tk-new-h">
          <div>
            <h2 id={`${id}-t`} className="tk-new-t">
              {t('tickets.create.title')}
            </h2>
            <div id={`${id}-d`} className="tk-new-d">
              {t('tickets.create.description')}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t('common.close')}
            onClick={close}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="tk-new-b">
          <Field
            label={t('tickets.create.fieldTitle')}
            htmlFor={`${id}-title`}
            error={missing ? t('tickets.create.titleRequired') : null}
          >
            <input
              id={`${id}-title`}
              data-autofocus
              className={missing ? 'input is-bad' : 'input'}
              placeholder={t('tickets.create.titlePlaceholder')}
              value={title}
              maxLength={MAX_TITLE}
              aria-invalid={missing}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
          </Field>
          <Field
            label={t('tickets.create.fieldDescription')}
            hint={t('tickets.create.optional')}
            htmlFor={`${id}-desc`}
          >
            <textarea
              id={`${id}-desc`}
              className="input"
              rows={3}
              maxLength={MAX_DESCRIPTION}
              placeholder={t('tickets.create.descriptionPlaceholder')}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </Field>
          <Field
            label={t('tickets.create.fieldAgent')}
            hint={t('tickets.create.optional')}
            htmlFor={`${id}-agent`}
          >
            <select
              id={`${id}-agent`}
              className="input"
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
              }}
            >
              <option value="">{t('tickets.create.noAgent')}</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {t('tickets.create.agentOption', { name: agent.name, category: agent.category })}
                </option>
              ))}
            </select>
          </Field>
          <div className="tk-new-grid">
            <Field label={t('tickets.create.fieldPriority')} htmlFor={`${id}-prio`}>
              <select
                id={`${id}-prio`}
                className="input"
                value={priority}
                onChange={(event) => {
                  setPriority(event.target.value as Priority);
                }}
              >
                {PRIORITIES.map((item) => (
                  <option key={item.key} value={item.key}>
                    {t(`tickets.priority.${item.key}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('tickets.create.fieldStatus')} htmlFor={`${id}-status`}>
              <select
                id={`${id}-status`}
                className="input"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as ChosenStatus);
                }}
              >
                {CHOSEN_STATUSES.map((item) => (
                  <option key={item} value={item}>
                    {t(`tickets.status.${item}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('tickets.create.fieldAssignee')} htmlFor={`${id}-as`}>
              <select
                id={`${id}-as`}
                className="input"
                value={assignToMe ? 'me' : ''}
                onChange={(event) => {
                  setAssignToMe(event.target.value === 'me');
                }}
              >
                <option value="">{t('tickets.create.unassigned')}</option>
                <option value="me">{t('tickets.create.me')}</option>
              </select>
            </Field>
          </div>
          {error ? (
            <div className="g-err" role="alert">
              {error}
            </div>
          ) : null}
        </div>
        <div className="tk-new-f">
          <button type="button" className="btn btn-sm" onClick={close} disabled={busy}>
            {t('tickets.create.cancel')}
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
            {t('tickets.create.submit')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
