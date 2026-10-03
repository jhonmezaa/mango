import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Revisión de agentes (design agent-review.jsx). */
export const agentReviewScreen: Screen = {
  view: 'review',
  paths: ['review/*'],
  available: true,
  Page: lazy(() =>
    import('./AgentReviewPage').then((module) => ({ default: module.AgentReviewPage })),
  ),
};
