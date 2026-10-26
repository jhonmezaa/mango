import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Skills: playbooks of instructions over MCP servers, one approval per version (D92). */
export const skillsScreen: Screen = {
  view: 'skills',
  paths: ['skills/*'],
  available: true,
  Page: lazy(() => import('./SkillsPage').then((module) => ({ default: module.SkillsPage }))),
};
