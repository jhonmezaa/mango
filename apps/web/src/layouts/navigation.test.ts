import { describe, expect, it } from 'vitest';

import { ShieldIcon } from '../components/icons';
import { VIEW_ICONS, canView, isAvailable, visibleGroups, type ViewKey } from './navigation';

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
  // Design 2026-10-16 (D82 (1)): anyone with a usable agent creates tasks.
  'schedules',
  'org',
];
const OWNER_EXTRA: ViewKey[] = ['governance', 'observability', 'evals', 'costs'];
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
    for (const hidden of [
      'budgets',
      'audit',
      'settings',
      'review',
      'models',
      'mcp',
      'knowledge',
      // Round 21 (D91 (4)): for whoever edits agents, not for FinOps central as such.
      'playground',
      // Round 21 (`ViewSkills`): for creators and administrators.
      'skills',
    ] as const) {
      expect(views).not.toContain(hidden);
    }
  });

  it('shows Org Chart to everyone (design USER_VIEWS, oct 2026)', () => {
    expect(canView({ role: null, is_admin: false, can: NOT_CREATOR }, 'org')).toBe(true);
    expect(canView({ role: 'bu-lead', is_admin: false, can: NOT_CREATOR }, 'org')).toBe(true);
  });

  it('adds the Catálogo de MCP, Knowledge Bases, the Playground and Skills for agent creators (design CREATOR_VIEWS)', () => {
    const views = visible({ role: null, is_admin: false, can: CREATOR });
    expect([...views].sort()).toEqual([...USER, 'mcp', 'knowledge', 'playground', 'skills'].sort());
    const central = visible({ role: 'finops-central', is_admin: false, can: CREATOR });
    expect([...central].sort()).toEqual(
      [...new Set([...USER, ...OWNER_EXTRA, 'mcp', 'knowledge', 'playground', 'skills'])].sort(),
    );
  });
});

describe('visibleGroups', () => {
  it('keeps each group with the views the account sees, and drops a group left without any', () => {
    const user = { role: null, is_admin: false, can: NOT_CREATOR };
    const groups = visibleGroups(user, [
      { id: 'gov', icon: ShieldIcon, items: ['approvals', 'budgets', 'audit'] },
      { id: 'build', icon: ShieldIcon, items: ['models', 'mcp', 'knowledge'] },
    ]);
    expect(groups.map((group) => [group.id, group.items])).toEqual([['gov', ['approvals']]]);
    expect(visibleGroups({ ...user, is_admin: true }).map((group) => group.id)).toEqual([
      'gov',
      'build',
      'ops',
    ]);
  });
});

describe('Inicio availability (D102)', () => {
  it('is available to whoever sees the organization and «Próximamente» for anyone else', () => {
    expect(isAvailable('dashboard', { is_admin: true, role: null })).toBe(true);
    expect(isAvailable('dashboard', { is_admin: false, role: 'finops-central' })).toBe(true);
    expect(isAvailable('dashboard', { is_admin: false, role: 'bu-lead' })).toBe(false);
    expect(isAvailable('dashboard', { is_admin: false, role: null })).toBe(false);
    // Any other view does not depend on the account.
    expect(isAvailable('governance', { is_admin: false, role: null })).toBe(true);
  });
});
