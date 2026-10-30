import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/**
 * Inicio: spend and invocations per day, approvals and budgets (design dashboard.jsx, D102).
 * The page itself keeps «Próximamente» for accounts that do not see the organization.
 */
export const homeScreen: Screen = {
  view: 'dashboard',
  paths: ['dashboard/*'],
  available: true,
  Page: lazy(() => import('./HomePage').then((module) => ({ default: module.HomePage }))),
};
