import { afterEach, describe, expect, it, vi } from 'vitest';

import { readPreference, writePreference } from './storage';
import { DEFAULT_THEME, applyTheme, currentTheme, readStoredTheme, setTheme } from './theme';

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('theme preference', () => {
  it('defaults to light when nothing is stored', () => {
    expect(DEFAULT_THEME).toBe('light');
    expect(readStoredTheme()).toBe('light');
    expect(currentTheme()).toBe('light');
  });

  it('lets a stored dark preference override the default', () => {
    window.localStorage.setItem('mango-theme', 'dark');
    expect(readStoredTheme()).toBe('dark');
  });

  it('persists the chosen theme and applies it to <html>', () => {
    setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('mango-theme')).toBe('dark');
    expect(readStoredTheme()).toBe('dark');
  });

  it('ignores unexpected stored values (storage is untrusted)', () => {
    window.localStorage.setItem('mango-theme', '"><script>alert(1)</script>');
    expect(readStoredTheme()).toBe('light');
  });

  it('falls back to the default when localStorage throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readPreference('mango-theme')).toBeNull();
    expect(readStoredTheme()).toBe('light');
  });

  it('still applies the theme when localStorage throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => {
      writePreference('mango-sb-groups', '{"gov":false}');
    }).not.toThrow();
    setTheme('dark');
    expect(currentTheme()).toBe('dark');
  });

  it('works when the localStorage accessor itself throws', () => {
    const accessor = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(readStoredTheme()).toBe('light');
    applyTheme('dark');
    expect(() => {
      setTheme('light');
    }).not.toThrow();
    expect(currentTheme()).toBe('light');
    accessor.mockRestore();
  });
});
