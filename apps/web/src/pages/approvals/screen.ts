import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Aprobaciones: write tool calls that wait for a person (design approvals.jsx, D27). */
export const approvalsScreen: Screen = {
  view: 'approvals',
  paths: ['approvals/*'],
  available: true,
  Page: lazy(() => import('./ApprovalsPage').then((module) => ({ default: module.ApprovalsPage }))),
};
