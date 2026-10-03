import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Keeps keyboard focus inside a dialog while it is active, closes it on Escape and restores the
 * previously focused element afterwards. The element marked `data-autofocus` (or the first
 * focusable one) receives focus when the trap activates.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean, onEscape?: () => void) {
  const ref = useRef<T>(null);
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    const container = ref.current;
    if (!active || !container) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () =>
      [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.closest('[inert]'),
      );
    const initial = container.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0];
    initial?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      // A nested widget (e.g. the account menu inside the mobile drawer) already handled the key.
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && onEscapeRef.current) {
        event.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusables();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!container.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [active]);

  return ref;
}
