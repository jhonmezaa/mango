import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Actividad: what the agents did in chats and tasks (design activity.jsx, D90). */
export const activityScreen: Screen = {
  view: 'activity',
  paths: ['activity/*'],
  available: true,
  Page: lazy(() => import('./ActivityPage').then((module) => ({ default: module.ActivityPage }))),
};
