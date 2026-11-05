import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Costos: the month's Bedrock spend for administrators and central FinOps (design costs2.jsx, D105). */
export const costsScreen: Screen = {
  view: 'costs',
  paths: ['costs/*'],
  available: true,
  Page: lazy(() => import('./CostsPage').then((module) => ({ default: module.CostsPage }))),
};
