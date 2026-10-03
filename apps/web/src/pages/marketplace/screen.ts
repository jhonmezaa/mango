import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Marketplace (design marketplace.jsx). */
export const marketplaceScreen: Screen = {
  view: 'marketplace',
  paths: ['marketplace/*'],
  available: true,
  Page: lazy(() =>
    import('./MarketplacePage').then((module) => ({ default: module.MarketplacePage })),
  ),
};
