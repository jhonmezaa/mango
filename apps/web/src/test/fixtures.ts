import { vi } from 'vitest';

import type { Agent } from '../agents/agents';
import type { ApiClient } from '../api/client';
import type { Me } from '../api/schemas';
import type { AuthContextValue } from '../auth/AuthContext';
import type { CognitoAuth } from '../auth/cognito/flows';
import type { SessionContextValue } from '../auth/SessionContext';
import type { RuntimeConfig } from '../config/runtimeConfig';

export const baseMe: Me = {
  user_id: 'a1b2c3d4-0000-4000-8000-0000000000ad',
  email: 'ana.perez@example.com',
  role: 'finops-central',
  business_unit: null,
  is_admin: false,
  groups: ['finops-central'],
  can: { create_agent: false },
};

export const testConfig: RuntimeConfig = {
  region: 'us-east-1',
  cognitoDomain: 'https://auth.example.com',
  userPoolId: 'us-east-1_Example1',
  clientId: 'exampleclientid123',
  apiBasePath: '/api',
  signUpDomains: ['example.com'],
  auth: { installationType: 'customer', mfa: 'required', sessionHours: 12 },
};

export function authValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    status: 'authenticated',
    errorKey: null,
    cognito: {} as CognitoAuth,
    acceptTokens: vi.fn(),
    ssoAvailable: false,
    startSso: vi.fn(() => Promise.resolve()),
    displayEmail: null,
    refreshSession: vi.fn(() => Promise.resolve(true)),
    logout: vi.fn(() => Promise.resolve()),
    getAccessToken: vi.fn(() => Promise.resolve('token')),
    expireSession: vi.fn(),
    ...overrides,
  };
}

/** An agent as GET /api/agents lists it (`AgentOut`). */
export function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'finops',
    status: 'published',
    version: 1,
    lock_version: null,
    name: 'FinOps',
    description: 'Consulta el gasto de AWS de tu organización.',
    category: 'FinOps',
    icon: 'Money',
    color: 1,
    role: 'FinOps lead',
    reports_to: 'platform',
    model: 'model-a',
    allowed_models: ['model-a'],
    tools: ['cost-explorer.get_cost_and_usage'],
    unavailable_tools: [],
    published_at: '2026-10-01T00:00:00+00:00',
    retired_at: null,
    retire_reason: null,
    is_mine: false,
    cleanup: null,
    ...overrides,
  };
}

export const finopsAgent = agentFixture();

export function sessionValue(overrides: Partial<SessionContextValue> = {}): SessionContextValue {
  return {
    api: {} as ApiClient,
    config: testConfig,
    me: baseMe,
    conversations: [],
    conversationsError: false,
    reloadConversations: vi.fn(),
    agents: [finopsAgent],
    agentsError: false,
    reloadAgents: vi.fn(),
    ...overrides,
  };
}
