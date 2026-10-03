import { describe, expect, it } from 'vitest';

import { VIEW_ICONS, canView, type ViewKey } from './navigation';

const ALL = Object.keys(VIEW_ICONS) as ViewKey[];
const USER: ViewKey[] = [
  'dashboard',
  'chat',
  'inbox',
  'marketplace',
  'tickets',
  'search',
  'approvals',
  'activity',
  'org',
];
const OWNER_EXTRA: ViewKey[] = [
  'governance',
  'playground',
  'skills',
  'knowledge',
  'schedules',
  'observability',
  'evals',
  'costs',
];
const NOT_CREATOR = { create_agent: false };
const CREATOR = { create_agent: true };

const visible = (me: Parameters<typeof canView>[0]) => ALL.filter((view) => canView(me, view));

describe('canView (UX only: the API authorizes every request)', () => {
  it('shows every view to admins, whatever the role', () => {
    expect(visible({ role: 'finops-central', is_admin: true, can: CREATOR })).toEqual(ALL);
    expect(visible({ role: 'bu-lead', is_admin: true, can: CREATOR })).toEqual(ALL);
  });

  it('shows only the user views to an area lead without Admin', () => {
    expect(visible({ role: 'bu-lead', is_admin: false, can: NOT_CREATOR })).toEqual(USER);
  });

  it('shows the user views to a user with groups and no FinOps role', () => {
    expect(visible({ role: null, is_admin: false, can: NOT_CREATOR })).toEqual(USER);
  });

  it('shows every view to an admin without a FinOps role', () => {
    expect(visible({ role: null, is_admin: true, can: CREATOR })).toEqual(ALL);
  });

  it('adds the owner views for FinOps central without Admin (design OWNER_VIEWS)', () => {
    const views = visible({ role: 'finops-central', is_admin: false, can: NOT_CREATOR });
    expect([...views].sort()).toEqual([...USER, ...OWNER_EXTRA].sort());
    for (const hidden of ['budgets', 'audit', 'settings', 'review', 'models', 'mcp'] as const) {
      expect(views).not.toContain(hidden);
    }
  });

  it('shows Org Chart to everyone (design USER_VIEWS, oct 2026)', () => {
    expect(canView({ role: null, is_admin: false, can: NOT_CREATOR }, 'org')).toBe(true);
    expect(canView({ role: 'bu-lead', is_admin: false, can: NOT_CREATOR }, 'org')).toBe(true);
  });

  it('adds the Catálogo de MCP for agent creators (design CREATOR_VIEWS)', () => {
    const views = visible({ role: null, is_admin: false, can: CREATOR });
    expect([...views].sort()).toEqual([...USER, 'mcp'].sort());
    const central = visible({ role: 'finops-central', is_admin: false, can: CREATOR });
    expect([...central].sort()).toEqual([...USER, ...OWNER_EXTRA, 'mcp'].sort());
  });
});
