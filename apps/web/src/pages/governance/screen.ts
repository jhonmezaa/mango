import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Gobernanza: what needs attention and how the controls work (design other-views.jsx, D89). */
export const governanceScreen: Screen = {
  view: 'governance',
  paths: ['governance/*'],
  available: true,
  Page: lazy(() =>
    import('./GovernancePage').then((module) => ({ default: module.GovernancePage })),
  ),
};
