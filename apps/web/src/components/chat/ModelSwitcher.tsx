import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CheckIcon, ChevronDownIcon } from '../icons';

interface Props {
  /** Models of the published version of the agent; the API accepts no other. */
  models: readonly string[];
  value: string;
  disabled?: boolean;
  onChange: (model: string) => void;
}

/**
 * Model of the next turn (design chat.jsx `ModelSwitcher`): one of the models the approved
 * version of the agent allows. The choice is only a request: the API checks it against that
 * version and against the model catalog on every turn.
 */
export function ModelSwitcher({ models, value, disabled = false, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative">
      <button
        type="button"
        className={
          open ? 'model-switch model-switch-btn mono is-open' : 'model-switch model-switch-btn mono'
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={t('chat.header.modelOf', { model: value })}
        disabled={disabled}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {value}
        <ChevronDownIcon size={10} />
      </button>
      {open ? (
        <div className="model-pop">
          <div className="model-pop-title" id={`${listId}-title`}>
            {t('chat.header.allowedModels')}
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-labelledby={`${listId}-title`}
            className="model-pop-list"
          >
            {models.map((model) => {
              const active = model === value;
              return (
                <li key={model} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={active ? 'model-pop-item is-active' : 'model-pop-item'}
                    onClick={() => {
                      onChange(model);
                      setOpen(false);
                    }}
                  >
                    <span className="mono">{model}</span>
                    {active ? <CheckIcon size={12} className="model-pop-check" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="model-pop-note">{t('chat.header.allowedModelsNote')}</div>
        </div>
      ) : null}
    </span>
  );
}
