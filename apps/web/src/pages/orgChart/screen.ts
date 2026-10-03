import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Org Chart (design other-views.jsx `OrgChart`). */
export const orgChartScreen: Screen = {
  view: 'org',
  paths: ['org/*'],
  available: true,
  Page: lazy(() => import('./OrgChartPage').then((module) => ({ default: module.OrgChartPage }))),
};
