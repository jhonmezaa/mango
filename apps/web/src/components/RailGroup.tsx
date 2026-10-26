import { useEffect, useLayoutEffect, useRef, type ComponentType, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { CheckIcon, type IconProps } from './icons';
import { SoonTag } from './Soon';

/** Hover delays of the design (shell.jsx `RailGroup`): open after 120 ms, close after 220 ms. */
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 220;
/** Margin the menu keeps from the window edges. */
const EDGE_PX = 8;

export interface RailItem {
  key: string;
  label: string;
  Icon?: ComponentType<IconProps>;
  /** Internal route; absent for a "Próximamente" view, which does not navigate. */
  to?: string;
  badge?: number | null;
  active?: boolean;
}

/** Which rail menu is open; `pin` keeps it open when the pointer leaves, `kb` moves the focus. */
export interface Fly {
  id: string;
  kb: boolean;
  pin: boolean;
}

interface Props {
  id: string;
  /** Group name: the menu's title and accessible name. */
  title: string;
  Icon: ComponentType<IconProps>;
  /** Button label when it is not the title («Más agentes fijados (n)»); it also gets a tip. */
  label?: string;
  items: readonly RailItem[];
  containsActive?: boolean;
  fly: Fly | null;
  setFly: (update: (current: Fly | null) => Fly | null) => void;
  onNavigate: () => void;
}

/**
 * One icon of the collapsed rail for a group of views (design shell.jsx `RailGroup`): its menu
 * opens on hover, click or keyboard, to the right of the rail. Item labels are rendered as text
 * and every destination is an internal route.
 */
export function RailGroup({
  id,
  title,
  Icon,
  label,
  items,
  containsActive = false,
  fly,
  setFly,
  onNavigate,
}: Props) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const open = fly?.id === id;
  const focusFirst = open && fly.kb;
  const count = items.reduce((sum, item) => sum + (item.badge ?? 0), 0);
  const menuId = `sb-fly-${id}`;

  const clearTimer = () => {
    window.clearTimeout(timer.current);
  };
  const show = (kb: boolean, pin: boolean) => {
    clearTimer();
    setFly(() => ({ id, kb, pin: kb || pin }));
  };
  const hide = (focusButton: boolean) => {
    clearTimer();
    setFly((current) => (current?.id === id ? null : current));
    if (focusButton) buttonRef.current?.focus();
  };

  // Aligned with the icon and kept inside the window; written through CSSOM (CSP style-src).
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const button = buttonRef.current;
    if (!open || !menu || !button) return;
    const top = button.getBoundingClientRect().top - 6;
    const max = window.innerHeight - menu.offsetHeight - EDGE_PX;
    menu.style.top = `${String(Math.max(EDGE_PX, Math.min(top, max)))}px`;
    if (focusFirst) {
      menu.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    }
  }, [open, focusFirst]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      window.clearTimeout(timer.current);
      setFly((current) => (current?.id === id ? null : current));
    };
    document.addEventListener('mousedown', away);
    return () => {
      document.removeEventListener('mousedown', away);
    };
  }, [open, id, setFly]);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (['Enter', ' ', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      show(true, true);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      hide(true);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current;
    if (!menu) return;
    const els = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const index = els.indexOf(document.activeElement as HTMLElement);
    const focus = (next: number) => {
      event.preventDefault();
      els[(next + els.length) % els.length]?.focus();
    };
    if (event.key === 'Escape') {
      event.preventDefault();
      hide(true);
    } else if (event.key === 'ArrowDown') focus(index + 1);
    else if (event.key === 'ArrowUp') focus(index - 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(els.length - 1);
    else if (event.key === 'Tab') hide(false);
  };

  const parts = [label ?? title];
  if (containsActive) parts.push(t('nav.rail.containsCurrent'));
  if (count > 0) parts.push(t('nav.rail.pending', { count }));

  const classes = ['sb-item', 'sb-rail-group'];
  if (containsActive) classes.push('is-current');
  if (open) classes.push('is-open');

  return (
    <div
      onMouseEnter={() => {
        clearTimer();
        if (!open)
          timer.current = window.setTimeout(() => {
            show(false, false);
          }, OPEN_DELAY_MS);
      }}
      onMouseLeave={() => {
        clearTimer();
        timer.current = window.setTimeout(() => {
          setFly((current) => (current?.id === id && !current.pin ? null : current));
        }, CLOSE_DELAY_MS);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={classes.join(' ')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={parts.join(', ')}
        data-tip={label && label !== title ? label : undefined}
        onClick={() => {
          if (!open) show(false, true);
          else if (!fly.pin) setFly(() => ({ ...fly, pin: true }));
          else hide(false);
        }}
        onKeyDown={onButtonKeyDown}
      >
        <span className="sb-item-icon" aria-hidden="true">
          <Icon size={16} />
        </span>
        {count > 0 ? <span className="sb-dot-badge" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={title}
          className="sb-fly"
          onKeyDown={onMenuKeyDown}
          onMouseEnter={clearTimer}
        >
          <div className="sb-fly-t" aria-hidden="true">
            {title}
          </div>
          {items.map((item) => {
            const inner = (
              <>
                {item.Icon ? (
                  <span className="sb-fly-ic" aria-hidden="true">
                    <item.Icon size={15} />
                  </span>
                ) : null}
                <span className="sb-fly-l">{item.label}</span>
                {!item.to ? (
                  <SoonTag />
                ) : item.badge ? (
                  <span className="sb-fly-n" aria-hidden="true">
                    {item.badge >= 99 ? '99+' : item.badge}
                  </span>
                ) : item.active ? (
                  <CheckIcon size={12} />
                ) : null}
              </>
            );
            if (!item.to) {
              return (
                <div
                  key={item.key}
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled="true"
                  className="sb-fly-i is-soon"
                  aria-label={t('soon.item', { label: item.label })}
                >
                  {inner}
                </div>
              );
            }
            const name = [item.badge ? `${item.label} (${String(item.badge)})` : item.label];
            if (item.active) name.push(t('nav.rail.currentView'));
            return (
              <Link
                key={item.key}
                to={item.to}
                role="menuitem"
                tabIndex={-1}
                className={item.active ? 'sb-fly-i active' : 'sb-fly-i'}
                aria-current={item.active ? 'page' : undefined}
                aria-label={name.join(', ')}
                onClick={() => {
                  hide(false);
                  onNavigate();
                }}
              >
                {inner}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
