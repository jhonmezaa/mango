import type { ComponentType, LazyExoticComponent } from 'react';

import { agentBuilderScreen } from '../pages/agentBuilder/screen';
import { agentReviewScreen } from '../pages/agentReview/screen';
import { approvalsScreen } from '../pages/approvals/screen';
import { brainsScreen } from '../pages/brains/screen';
import { marketplaceScreen } from '../pages/marketplace/screen';
import { mcpCatalogScreen } from '../pages/mcpCatalog/screen';
import { orgChartScreen } from '../pages/orgChart/screen';
import type { ViewKey } from './navigation';

/**
 * A screen that owns its routes and its availability. The router (App.tsx) and the navigation
 * read this list, so building a screen only touches the files of its own folder
 * (`pages/<screen>/`): its `screen.ts`, its page and its components.
 */
export interface Screen {
  /** Navigation view the screen implements; null when it has no entry of its own. */
  view: ViewKey | null;
  /** Route patterns, relative to the app layout. */
  paths: readonly string[];
  /** False while the page still renders "Próximamente": its navigation entry stays disabled. */
  available: boolean;
  /** Loaded on demand, out of the main chunk. */
  Page: LazyExoticComponent<ComponentType>;
}

export const SCREENS: readonly Screen[] = [
  marketplaceScreen,
  agentBuilderScreen,
  agentReviewScreen,
  orgChartScreen,
  brainsScreen,
  mcpCatalogScreen,
  approvalsScreen,
];
