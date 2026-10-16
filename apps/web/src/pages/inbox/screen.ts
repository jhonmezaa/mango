import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Bandeja: approvals to sign and notices of task runs (design other-views.jsx `Inbox`, D83). */
export const inboxScreen: Screen = {
  view: 'inbox',
  paths: ['inbox/*'],
  available: true,
  Page: lazy(() => import('./InboxPage').then((module) => ({ default: module.InboxPage }))),
};
