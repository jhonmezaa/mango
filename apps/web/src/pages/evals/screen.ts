import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Evals: suites of cases that score a version of an agent (design evals.jsx, D110, D111). */
export const evalsScreen: Screen = {
  view: 'evals',
  paths: ['evals/*'],
  available: true,
  Page: lazy(() => import('./EvalsPage').then((module) => ({ default: module.EvalsPage }))),
};
