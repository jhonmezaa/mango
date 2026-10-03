import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { CopyIcon, EditIcon, MoreHorizontalIcon } from '../icons';
import { SoonTag } from '../Soon';
import { ArchiveIcon, ShareIcon } from './icons';

interface Props {
  name: string;
  /** Hint from GET /api/me; the API authorizes each action (`EditAgent`, `RetireAgent`). */
  isAdmin: boolean;
  /** A copy is being created: its item waits. */
  cloning: boolean;
  onEdit: () => void;
  onClone: () => void;
  onRetire: () => void;
}

/**
 * «Más opciones» of an agent (design marketplace.jsx `AgentMenu`): Editar, Compartir…, Duplicar
 * and, for admins, Retirar…. «Compartir…» is "Próximamente": in phase A the access groups are
 * edited in the Agent Builder (D38).
 * Keyboard: arrows move, Home and End jump, Escape closes and returns focus to the button.
 */
export function AgentMenu({ name, isAdmin, cloning, onEdit, onClone, onRetire }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const items = () => [
    ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The card behind is a button too: keys pressed in the menu never reach it.
    event.stopPropagation();
    if (!open) return;
    const list = items();
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

  const item = (label: string, icon: ReactNode, run: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      className="mk-menu-item"
      disabled={disabled}
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div
      ref={rootRef}
      className="relative"
      onClick={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={onKeyDown}
    >
      <button
        ref={buttonRef}
        type="button"
        className="mk-icon"
        title={t('marketplace.menu.title')}
        aria-label={t('marketplace.menu.label', { name })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontalIcon size={13} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="card mk-menu"
          role="menu"
          aria-label={t('marketplace.menu.label', { name })}
        >
          {item(t('marketplace.menu.edit'), <EditIcon size={12} />, onEdit)}
          <button
            type="button"
            role="menuitem"
            className="mk-menu-item"
            aria-disabled="true"
            title={t('soon.title')}
          >
            <ShareIcon size={12} />
            <span>{t('marketplace.menu.share')}</span>
            <SoonTag />
          </button>
          {item(t('marketplace.menu.clone'), <CopyIcon size={12} />, onClone, cloning)}
          {isAdmin ? (
            <>
              <div className="mk-menu-sep" />
              <button
                type="button"
                role="menuitem"
                className="mk-menu-item is-danger"
                onClick={() => {
                  setOpen(false);
                  onRetire();
                }}
              >
                <ArchiveIcon size={12} />
                <span>{t('marketplace.menu.retire')}</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
