/**
 * Local mock of Cognito (user pool API + managed login) and mango-api for `pnpm dev:mock`
 * (docs/specs/poc-api-contract.md). Dev-server only: it is a Vite plugin, never part of the
 * production bundle, and calls no AWS API. The app runs its real SRP and OAuth code + PKCE flows
 * against these endpoints; there is no auth bypass in the application code (see `cognito.ts`).
 *
 * This file only wires the pieces. Each domain keeps its state and routes in its own module, so
 * a screen is built without touching the others.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Connect, Plugin } from 'vite';

import { handleAdmin } from './admin.ts';
import { handleAgentBuilder } from './agentBuilder.ts';
import { handleAgentReview } from './agentReview.ts';
import { handleAgents } from './agents.ts';
import { handleApprovals } from './approvals.ts';
import { handleAudit } from './audit.ts';
import { handleBrains } from './brains.ts';
import { handleChatApi } from './chat.ts';
import {
  MOCK_USER,
  MOCK_USER_AREA,
  handleCognito,
  handleCognitoApi,
  sessionOf,
} from './cognito.ts';
import { handleDirectory } from './directory.ts';
import { handleGroups } from './groups.ts';
import { originOf, sendError, sendJson, type ApiHandler } from './http.ts';
import { handleMarketplace } from './marketplace.ts';
import { handleMcpCatalog } from './mcpCatalog.ts';
import { handleOrgChart } from './orgChart.ts';
import { handlePeople } from './people.ts';

/**
 * Tried in order until one answers. The screens of the marketplace go before `handleAgents`,
 * whose `/agents/{id}` would otherwise take `/agents/mine`, `/agents/reviews` and `/agents/org`.
 */
const API_HANDLERS: readonly ApiHandler[] = [
  handleChatApi,
  handleApprovals,
  handleGroups,
  handleDirectory,
  handlePeople,
  handleAdmin,
  handleAudit,
  handleBrains,
  handleMcpCatalog,
  handleMarketplace,
  handleAgentBuilder,
  handleAgentReview,
  handleOrgChart,
  handleAgents,
];

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname.replace(/^\/api/, '');
  if (path === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  const session = sessionOf(req);
  if (session === null) {
    sendError(res, 401, 'unauthorized', 'Missing or invalid token');
    return;
  }
  if (session === 'no_group') {
    sendError(res, 403, 'no_group', 'no group assigned yet');
    return;
  }
  if (path === '/me' && req.method === 'GET') {
    sendJson(res, 200, {
      user_id: MOCK_USER,
      email: MOCK_USER,
      name: 'Usuario 1',
      role: 'finops-central',
      business_unit: MOCK_USER_AREA,
      is_admin: true,
      groups: ['finops-central', 'mango-admin'],
      can: { create_agent: true },
    });
    return;
  }
  for (const handler of API_HANDLERS) {
    if (await handler(req, res, path, url)) return;
  }
  sendError(res, 404, 'not_found', 'Not found');
}

/** The mock as a connect middleware (exported for tests). */
export function middleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', originOf(req));
    const handle = async () => {
      if (url.pathname === '/config.json') {
        const origin = originOf(req);
        sendJson(res, 200, {
          region: 'us-east-1',
          cognitoDomain: `${origin}/mock-cognito`,
          userPoolId: 'us-east-1_MockPool',
          clientId: 'mockclient',
          apiBasePath: '/api',
          signUpDomains: ['example.com'],
          aiPolicyUrl: 'https://example.com/politica-uso-ia',
          auth: { installationType: 'lab', mfa: 'required', sessionHours: 12 },
          ssoProvider: 'MockIdP',
          issuer: `${origin}/mock-cognito`,
          cognitoIdpEndpoint: `${origin}/mock-cognito-idp`,
        });
        return true;
      }
      if (url.pathname === '/mock-cognito-idp' && req.method === 'POST') {
        await handleCognitoApi(req, res);
        return true;
      }
      if (url.pathname.startsWith('/mock-cognito/')) {
        await handleCognito(req, res, url);
        return true;
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return true;
      }
      return false;
    };
    handle().then(
      (handled) => {
        if (!handled) next();
      },
      () => {
        if (!res.headersSent) sendError(res, 500, 'internal_error', 'Mock failure');
        else res.end();
      },
    );
  };
}

export function mockBackend(): Plugin {
  return {
    name: 'mango-mock-backend',
    configureServer(server) {
      server.middlewares.use(middleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware());
    },
  };
}
