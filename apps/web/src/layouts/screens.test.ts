import { describe, expect, it } from 'vitest';

import { VIEW_ICONS, isAvailable, viewForPath } from './navigation';
import { SCREENS } from './screens';

describe('SCREENS', () => {
  it('registers the marketplace screens with their design routes', () => {
    expect(SCREENS.map((screen) => [screen.view, ...screen.paths])).toEqual([
      ['marketplace', 'marketplace/*'],
      [null, 'admin/*'],
      ['review', 'review/*'],
      ['org', 'org/*'],
      ['models', 'models/*'],
      ['mcp', 'mcp/*'],
      ['approvals', 'approvals/*'],
    ]);
  });

  it('does not share a route or a view between two screens', () => {
    const paths = SCREENS.flatMap((screen) => screen.paths);
    expect(new Set(paths).size).toBe(paths.length);
    const views = SCREENS.flatMap((screen) => (screen.view ? [screen.view] : []));
    expect(new Set(views).size).toBe(views.length);
  });

  it('routes each view under its own key, so the navigation marks it active', () => {
    for (const screen of SCREENS) {
      if (!screen.view) continue;
      expect(Object.hasOwn(VIEW_ICONS, screen.view)).toBe(true);
      expect(screen.paths).toContain(`${screen.view}/*`);
      expect(viewForPath(`/${screen.view}/detail`)).toBe(screen.view);
    }
  });

  it('makes a view available in the navigation only when its screen says so', () => {
    for (const screen of SCREENS) {
      if (screen.view) expect(isAvailable(screen.view)).toBe(screen.available);
    }
  });
});
