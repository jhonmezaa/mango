import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Playground: test a draft or the published version before sending it to review (D91). */
export const playgroundScreen: Screen = {
  view: 'playground',
  paths: ['playground/*'],
  available: true,
  Page: lazy(() =>
    import('./PlaygroundPage').then((module) => ({ default: module.PlaygroundPage })),
  ),
};
