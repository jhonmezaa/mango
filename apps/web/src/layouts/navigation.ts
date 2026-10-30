import type { ComponentType } from 'react';

import type { Me } from '../api/schemas';
import {
  ActivityIcon,
  BookOpenIcon,
  BotIcon,
  ChatIcon,
  Check2Icon,
  CheckIcon,
  ClockIcon,
  CloudIcon,
  DashboardIcon,
  EyeIcon,
  InboxIcon,
  LockIcon,
  MoneyIcon,
  OrgIcon,
  PlayIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SkillIcon,
  StoreIcon,
  TicketsIcon,
  ZapIcon,
  type IconProps,
} from '../components/icons';
import { seesOrganization } from '../pages/home/model';
import { SCREENS } from './screens';

// Views of the design (shell.jsx / app.jsx) and where they live in the router. Only the views in
// AVAILABLE_VIEWS have a backend today (design store.js `AVAILABLE`); every other one renders
// SoonView and shows up disabled as "Próximamente" in the navigation. The screens of `screens.ts`
// declare their own availability in their folder.

export type ViewKey =
  | 'dashboard'
  | 'chat'
  | 'inbox'
  | 'marketplace'
  | 'tickets'
  | 'search'
  | 'approvals'
  | 'review'
  | 'governance'
  | 'budgets'
  | 'audit'
  | 'activity'
  | 'playground'
  | 'models'
  | 'skills'
  | 'mcp'
  | 'knowledge'
  | 'schedules'
  | 'observability'
  | 'evals'
  | 'costs'
  | 'org'
  | 'settings';

export type GroupId = 'gov' | 'build' | 'ops';

export const AVAILABLE_VIEWS: ReadonlySet<ViewKey> = new Set<ViewKey>([
  'chat',
  'budgets',
  'audit',
  'settings',
  ...SCREENS.flatMap((screen) => (screen.available && screen.view ? [screen.view] : [])),
]);

/**
 * Design store.js USER_VIEWS: what every account sees. Admins see every view. Org Chart is here
 * (design oct 2026): the API returns each caller the tree they may see (D38). Schedules too
 * (design 2026-10-16, D82 (1)): anyone with a usable agent creates tasks; the API lists theirs.
 */
const USER_VIEWS: ReadonlySet<ViewKey> = new Set([
  'chat',
  'inbox',
  'dashboard',
  'marketplace',
  'tickets',
  'activity',
  'search',
  'approvals',
  'org',
  'schedules',
]);

/**
 * Design store.js CREATOR_VIEWS: agent creators also get the Catálogo de MCP (the Agent Builder,
 * `admin` in the design, has no navigation entry of its own), the Playground (round 21, D91
 * (4): it is for whoever edits agents) and Skills (round 21, `ViewSkills`).
 */
const CREATOR_VIEWS: ReadonlySet<ViewKey> = new Set(['mcp', 'knowledge', 'playground', 'skills']);

/**
 * Design store.js OWNER_VIEWS: FinOps central without Admin also sees these (all "Próximamente"
 * today). Presupuestos stays admin-only, as in the design's availability mode. Knowledge Bases
 * is for creators and administrators only (design «Quién ve qué», and `ViewKnowledgeBase`).
 */
const OWNER_VIEWS: ReadonlySet<ViewKey> = new Set([
  ...USER_VIEWS,
  'governance',
  'schedules',
  'observability',
  'evals',
  'costs',
]);

export const NAV_PRIMARY: readonly ViewKey[] = [
  'dashboard',
  'chat',
  'inbox',
  'marketplace',
  'tickets',
  'search',
];

export interface NavGroup {
  id: GroupId;
  icon: ComponentType<IconProps>;
  items: readonly ViewKey[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'gov',
    icon: ShieldIcon,
    items: ['approvals', 'review', 'governance', 'budgets', 'audit', 'activity'],
  },
  {
    id: 'build',
    icon: SkillIcon,
    items: ['playground', 'models', 'skills', 'mcp', 'knowledge', 'schedules'],
  },
  { id: 'ops', icon: ActivityIcon, items: ['observability', 'evals', 'costs', 'org'] },
];

export const VIEW_ICONS: Record<ViewKey, ComponentType<IconProps>> = {
  dashboard: DashboardIcon,
  chat: ChatIcon,
  inbox: InboxIcon,
  marketplace: StoreIcon,
  tickets: TicketsIcon,
  search: SearchIcon,
  review: EyeIcon,
  approvals: Check2Icon,
  governance: ShieldIcon,
  budgets: MoneyIcon,
  audit: LockIcon,
  activity: ActivityIcon,
  playground: PlayIcon,
  models: BotIcon,
  skills: SkillIcon,
  mcp: CloudIcon,
  knowledge: BookOpenIcon,
  schedules: ClockIcon,
  observability: ActivityIcon,
  evals: CheckIcon,
  costs: ZapIcon,
  org: OrgIcon,
  settings: SettingsIcon,
};

/** Chat keeps its existing URLs (`/` and `/c/:id`); every other view is `/<key>`. */
export function viewPath(view: ViewKey): string {
  return view === 'chat' ? '/' : `/${view}`;
}

/** The view a pathname belongs to, for active states. */
export function viewForPath(pathname: string): ViewKey | null {
  if (pathname === '/' || pathname.startsWith('/c/') || pathname.startsWith('/chat')) return 'chat';
  const segment = pathname.split('/')[1] ?? '';
  return Object.hasOwn(VIEW_ICONS, segment) ? (segment as ViewKey) : null;
}

/** The groups with the views the account can see; a group left without views is not shown. */
export function visibleGroups(
  me: Pick<Me, 'is_admin' | 'role' | 'can'>,
  groups: readonly NavGroup[] = NAV_GROUPS,
): NavGroup[] {
  return groups
    .map((group) => ({ ...group, items: group.items.filter((view) => canView(me, view)) }))
    .filter((group) => group.items.length > 0);
}

/**
 * Inicio (D102) has data only for whoever sees the organization until the design draws the area
 * and personal variants; for anyone else it stays «Próximamente». UX only: the API decides.
 */
export function isAvailable(view: ViewKey, me?: Pick<Me, 'is_admin' | 'role'>): boolean {
  if (view === 'dashboard' && me && !seesOrganization(me)) return false;
  return AVAILABLE_VIEWS.has(view);
}

/**
 * UX only: hides what the account cannot open. The role comes from GET /api/me (derived server-side
 * from the verified JWT) and the API enforces authorization on every request (REACT-AUTHZ-001).
 * A user with Mango groups but no FinOps role (`role: null`) sees the user views. Creators are
 * the accounts the API lets create agents (`can.create_agent`, the same Cedar decision).
 */
export function canView(me: Pick<Me, 'is_admin' | 'role' | 'can'>, view: ViewKey): boolean {
  if (me.is_admin) return true;
  if (me.can.create_agent && CREATOR_VIEWS.has(view)) return true;
  return (me.role === 'finops-central' ? OWNER_VIEWS : USER_VIEWS).has(view);
}
