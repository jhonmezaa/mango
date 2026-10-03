import { useCallback, useSyncExternalStore } from 'react';

import { readPreference, writePreference } from './storage';

export type Theme = 'dark' | 'light';

const THEME_KEY = 'mango-theme';
export const DEFAULT_THEME: Theme = 'light';
const listeners = new Set<() => void>();

function isTheme(value: string | null | undefined): value is Theme {
  return value === 'light' || value === 'dark';
}

/** Stored theme, validated: missing, unreadable or unexpected values fall back to the default. */
export function readStoredTheme(): Theme {
  const stored = readPreference(THEME_KEY);
  return isTheme(stored) ? stored : DEFAULT_THEME;
}

/** Theme currently applied to the document. */
export function currentTheme(): Theme {
  const applied = document.documentElement.dataset.theme;
  return isTheme(applied) ? applied : DEFAULT_THEME;
}

/**
 * Applies a theme to <html>. Called from main.tsx before the first render, so no inline script is
 * needed (CSP `script-src 'self'`).
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  writePreference(THEME_KEY, theme);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => DEFAULT_THEME);
  const toggleTheme = useCallback(() => {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  }, []);
  return { theme, toggleTheme };
}
