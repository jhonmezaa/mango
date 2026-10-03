import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Brains: the model catalog (design models-view.jsx). */
export const brainsScreen: Screen = {
  view: 'models',
  paths: ['models/*'],
  available: true,
  Page: lazy(() => import('./BrainsPage').then((module) => ({ default: module.BrainsPage }))),
};
