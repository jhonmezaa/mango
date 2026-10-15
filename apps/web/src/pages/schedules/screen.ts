import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Schedules: tasks a published agent runs without chat (design schedules.jsx, D78). */
export const schedulesScreen: Screen = {
  view: 'schedules',
  paths: ['schedules/*'],
  available: true,
  Page: lazy(() => import('./SchedulesPage').then((module) => ({ default: module.SchedulesPage }))),
};
