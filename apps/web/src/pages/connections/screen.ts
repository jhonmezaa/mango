import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';
import { RETURN_PATH } from './model';

/**
 * The return from AgentCore Identity (design `connect-return`, P-1). No navigation entry: the
 * person only arrives here from the provider.
 */
export const connectReturnScreen: Screen = {
  view: null,
  paths: [RETURN_PATH.slice(1)],
  available: true,
  Page: lazy(() =>
    import('./ConnectReturnPage').then((module) => ({ default: module.ConnectReturnPage })),
  ),
};
