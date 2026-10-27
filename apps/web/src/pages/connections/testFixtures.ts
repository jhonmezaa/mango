import type { Connection } from './model';

/** A registration of the person's groups, as `GET /api/me/connections` lists it. */
export function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    registration_id: 'abcdefghij23',
    profile_id: 'azure-devops',
    service: 'Azure DevOps',
    provider: 'Microsoft',
    organization: 'empresa',
    link_hosts: ['dev.azure.com', 'visualstudio.com'],
    status: 'not_connected',
    connected_at: null,
    ...overrides,
  };
}
