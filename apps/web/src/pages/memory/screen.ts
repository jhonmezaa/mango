import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/**
 * Memoria (D122, design round 41 memory.jsx): what the agents remember of the person. A page of
 * its own, opened from the account menu, for everyone with a session; it shows only their own.
 */
export const memoryScreen: Screen = {
  view: 'memory',
  paths: ['memory/*'],
  available: true,
  Page: lazy(() => import('./MemoryPage').then((module) => ({ default: module.MemoryPage }))),
};
