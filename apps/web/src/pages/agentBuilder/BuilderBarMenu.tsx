import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { MoreHorizontalIcon } from '../../components/icons';

interface Props {
  /** A write is in flight: saving waits. */
  disabled: boolean;
  onSaveDraft: () => void;
  onCancel: () => void;
}

/**
 * «⋯» of the Builder bar at ≤560 px (design admin.jsx `barMenu`): Guardar borrador and Cancelar,
 * which do not fit next to «Enviar».
 * Keyboard: arrows move, Home and End jump, Escape closes and returns focus to the button.
 */
export function BuilderBarMenu({ disabled, onSaveDraft, onCancel }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const list = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []),
    ];
    const index = list.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => {
      list[(next + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        break;
      case 'Tab':
        setOpen(false);
        break;
      case 'ArrowDown':
        event.preventDefault();
        focusAt(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusAt(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusAt(list.length - 1);
        break;
    }
  };

  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div ref={rootRef} className="ab-bar-menu" onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-sm btn-ghost btn-icon"
        aria-label={t('agentBuilder.actions.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontalIcon size={15} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="card ab-menu"
          role="menu"
          aria-label={t('agentBuilder.actions.more')}
        >
          <button
            type="button"
            role="menuitem"
            className="ab-menu-item"
            disabled={disabled}
            onClick={run(onSaveDraft)}
          >
            {t('agentBuilder.actions.saveDraft')}
          </button>
          <button type="button" role="menuitem" className="ab-menu-item" onClick={run(onCancel)}>
            {t('agentBuilder.actions.cancel')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
