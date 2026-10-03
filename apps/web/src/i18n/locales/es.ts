import { agentBuilder } from './es/agentBuilder';
import { agentReview } from './es/agentReview';
import { approvals } from './es/approvals';
import { audit } from './es/audit';
import { auth } from './es/auth';
import { brains } from './es/brains';
import { budgets } from './es/budgets';
import { agent, agentPicker, chat, markdown } from './es/chat';
import { admin, gov } from './es/governance';
import { groups } from './es/groups';
import { marketplace } from './es/marketplace';
import { mcpCatalog } from './es/mcpCatalog';
import { orgChart } from './es/orgChart';
import { settings } from './es/settings';
import { app, common, config, errors, nav, notFound, roles, soon } from './es/shell';

// Spanish resources, one module per view under `es/`. A view adds its texts in its own module.
export const es = {
  app,
  agent,
  agentPicker,
  auth,
  common,
  config,
  nav,
  soon,
  roles,
  chat,
  markdown,
  admin,
  gov,
  budgets,
  settings,
  audit,
  errors,
  notFound,
  marketplace,
  agentBuilder,
  agentReview,
  orgChart,
  brains,
  groups,
  mcpCatalog,
  approvals,
} as const;
