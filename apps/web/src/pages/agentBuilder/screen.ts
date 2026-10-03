import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/**
 * Agent Builder (design admin.jsx `AgentAdmin`, view `admin`): `/admin` for a new agent,
 * `/admin/<agentId>` to edit one and `/admin/<agentId>/<version>` for one of its versions. It
 * has no navigation entry of its own; the Marketplace links to it.
 */
export const agentBuilderScreen: Screen = {
  view: null,
  paths: ['admin/*'],
  available: true,
  Page: lazy(() =>
    import('./AgentBuilderPage').then((module) => ({ default: module.AgentBuilderPage })),
  ),
};
