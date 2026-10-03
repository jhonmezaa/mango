import { lazy } from 'react';

import type { Screen } from '../../layouts/screens';

/** Catálogo de MCP: connectors of Mango and MCP packs (design mcp-catalog.jsx). */
export const mcpCatalogScreen: Screen = {
  view: 'mcp',
  paths: ['mcp/*'],
  available: true,
  Page: lazy(() =>
    import('./McpCatalogPage').then((module) => ({ default: module.McpCatalogPage })),
  ),
};
