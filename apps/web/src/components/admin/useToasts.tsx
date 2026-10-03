import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CheckIcon, CloseIcon, InfoIcon, WarnIcon, X2Icon } from '../icons';

// --- Toasts (design ui.jsx ToastProvider) ---------------------------------------------------

export type ToastTone = 'success' | 'info' | 'warn' | 'error';
interface ToastItem {
  id: number;
  tone: ToastTone;
  msg: string;
  title?: string;
}
const TOAST_ICON = { success: CheckIcon, error: X2Icon, warn: WarnIcon, info: InfoIcon };
const TOAST_MS = 4200;

/** Page-local toasts: `notify(msg, tone, title)` and the stack to render once in the page. */
export function useToasts() {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((item) => item.id !== id));
  }, []);
  const notify = useCallback(
    (msg: string, tone: ToastTone = 'success', title?: string) => {
      nextId.current += 1;
      const id = nextId.current;
      setToasts((list) => [...list, title ? { id, tone, msg, title } : { id, tone, msg }]);
      window.setTimeout(() => {
        dismiss(id);
      }, TOAST_MS);
    },
    [dismiss],
  );
  const stack = (
    <div className="g-toasts" role="status" aria-live="polite">
      {toasts.map((item) => {
        const Icon = TOAST_ICON[item.tone];
        return (
          <div key={item.id} className="g-toast-item" data-tone={item.tone}>
            <span className="g-toast-i">
              <Icon size={13} />
            </span>
            <div className="min-w-0 flex-1">
              {item.title ? (
                <>
                  <div className="g-toast-t">{item.title}</div>
                  <div className="g-toast-m">{item.msg}</div>
                </>
              ) : (
                item.msg
              )}
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-icon g-toast-x"
              aria-label={t('common.close')}
              onClick={() => {
                dismiss(item.id);
              }}
            >
              <CloseIcon size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
  return { notify, stack };
}
