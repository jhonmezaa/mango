import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Buscar conversaciones: the person's own conversations (design search.jsx, D103). */
export const searchScreen: Screen = {
  view: 'search',
  paths: ['search/*'],
  available: true,
  Page: lazy(() => import('./SearchPage').then((module) => ({ default: module.SearchPage }))),
};
