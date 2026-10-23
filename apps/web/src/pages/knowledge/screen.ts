import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Knowledge Bases: the documents agents consult (design knowledge.jsx, D88). */
export const knowledgeScreen: Screen = {
  view: 'knowledge',
  paths: ['knowledge/*'],
  available: true,
  Page: lazy(() => import('./KnowledgePage').then((module) => ({ default: module.KnowledgePage }))),
};
