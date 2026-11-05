import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Tickets: the board, the list and the panel of one ticket (design tickets.jsx, D112). */
export const ticketsScreen: Screen = {
  view: 'tickets',
  paths: ['tickets/*'],
  available: true,
  Page: lazy(() => import('./TicketsPage').then((module) => ({ default: module.TicketsPage }))),
};
