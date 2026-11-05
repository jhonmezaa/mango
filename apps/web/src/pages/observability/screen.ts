import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Observability: each turn of an agent as a trace (design observability2.jsx, D108, D109). */
export const observabilityScreen: Screen = {
  view: 'observability',
  paths: ['observability/*'],
  available: true,
  Page: lazy(() =>
    import('./ObservabilityPage').then((module) => ({ default: module.ObservabilityPage })),
  ),
};
