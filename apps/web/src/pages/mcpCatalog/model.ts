import type { z } from 'zod';

import type { zCatalogConnectorSchema, zCatalogOutSchema } from '@mango/api-client/schemas';

import type { BadgeTone } from '../../components/Badge';

// Pure helpers of the MCP catalog (design mcp-catalog.jsx): status, filters, requests and what
// each form sends. Everything here reads the contract of GET /api/mcp/catalog.

export type Catalog = z.output<typeof zCatalogOutSchema>;
export type Server = z.output<typeof zCatalogConnectorSchema>;
export type Pack = NonNullable<Server['pack']>;
export type PackRequest = NonNullable<Pack['pending']>;
export type Tool = Server['tools'][number];

/**
 * Status of a row. Packs bring theirs; a connector of Mango comes installed with the release.
 * `soon` of the design has no value in the API.
 */
export type ServerStatus = Pack['status'];

export function statusOf(server: Server): ServerStatus {
  if (server.pack) return server.pack.status;
  return server.enabled ? 'enabled' : 'disabled';
}

/** Order of the status filter (design `MCP_STATUS`, plus the API's `disabling`). */
export const STATUS_ORDER: readonly ServerStatus[] = [
  'available',
  'pending',
  'installing',
  'enabled',
  'error',
  'disabling',
  'disabled',
];

export const STATUS_TONE: Record<ServerStatus, BadgeTone> = {
  available: 'neutral',
  pending: 'amber',
  installing: 'blue',
  enabled: 'green',
  error: 'red',
  disabling: 'blue',
  disabled: 'neutral',
};

/** The provisioner is working: the page reloads the catalog until it settles. */
export function isWorking(status: ServerStatus): boolean {
  return status === 'installing' || status === 'disabling';
}

/** Design `DATA_LEVEL`, with the ids of the API (`account_data` is the design's `accounts`). */
export const LEVELS = ['public', 'internal', 'account_data', 'write'] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_TONE: Record<Level, BadgeTone> = {
  public: 'neutral',
  internal: 'blue',
  account_data: 'violet',
  write: 'amber',
};

export function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value);
}

/**
 * How a server over account data reaches them (design `mcpModeOf`): `central` answers for the
 * whole organization, `user` filters by who asks. Other data levels have no mode.
 */
export type DataMode = 'central' | 'user';

export function dataModeOf(server: Server): DataMode | null {
  if (server.data_tier !== 'account_data') return null;
  return server.identity_mode === 'per_user' ? 'user' : 'central';
}

/** A tool only central users may call, whatever the agent says (design `scope: 'org'`). */
export function isCentralTool(tool: Tool): boolean {
  return tool.central_groups_only || tool.audience === 'central';
}

/**
 * AWS services the customer turns on in the payer account for some tools to answer (design
 * `inactive`). The API names them from release data; it does not know whether they are on.
 */
export function requiredServices(server: Server): string[] {
  return [...new Set(server.tools.flatMap((tool) => tool.requires_service ?? []))];
}

export type KindFilter = 'all' | 'connector' | 'pack';

export interface Filters {
  query: string;
  kind: KindFilter;
  status: 'all' | ServerStatus;
  level: 'all' | Level;
}

export const NO_FILTERS: Filters = { query: '', kind: 'all', status: 'all', level: 'all' };

export function hasFilters(filters: Filters): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.kind !== 'all' ||
    filters.status !== 'all' ||
    filters.level !== 'all'
  );
}

/** Design order: packs first, then by name. */
export function filterServers(servers: readonly Server[], filters: Filters): Server[] {
  const needle = filters.query.trim().toLowerCase();
  return servers
    .filter((server) => {
      if (filters.kind !== 'all' && server.kind !== filters.kind) return false;
      if (filters.status !== 'all' && statusOf(server) !== filters.status) return false;
      if (filters.level !== 'all' && server.data_tier !== filters.level) return false;
      if (!needle) return true;
      const tools = server.tools.map((tool) => tool.name).join(' ');
      return `${server.name} ${server.id} ${server.description} ${tools}`
        .toLowerCase()
        .includes(needle);
    })
    .toSorted(
      (a, b) =>
        Number(b.kind === 'pack') - Number(a.kind === 'pack') || a.name.localeCompare(b.name, 'es'),
    );
}

export function writeTools(server: Server): number {
  return server.tools.filter((tool) => tool.access === 'write').length;
}

export interface ToolRow {
  server: Server;
  tool: Tool;
}

export function toolRows(servers: readonly Server[]): ToolRow[] {
  return servers.flatMap((server) => server.tools.map((tool) => ({ server, tool })));
}

export type ToolKind = 'all' | 'read' | 'write';

export interface ToolFilters {
  query: string;
  kind: ToolKind;
  /** Only the tools an agent can use now (`tools[].enabled`). */
  onlyEnabled: boolean;
}

export function filterTools(rows: readonly ToolRow[], filters: ToolFilters): ToolRow[] {
  const needle = filters.query.trim().toLowerCase();
  return rows.filter(({ server, tool }) => {
    if (filters.kind !== 'all' && (tool.access === 'write') !== (filters.kind === 'write')) {
      return false;
    }
    if (filters.onlyEnabled && !tool.enabled) return false;
    return (
      !needle || `${tool.name} ${tool.description} ${server.name}`.toLowerCase().includes(needle)
    );
  });
}

/** A request another administrator must decide. Only administrators receive them. */
export interface PendingRequest {
  server: Server;
  pack: Pack;
  request: PackRequest;
}

export function pendingRequests(servers: readonly Server[]): PendingRequest[] {
  return servers.flatMap((server) =>
    server.pack?.pending ? [{ server, pack: server.pack, request: server.pack.pending }] : [],
  );
}

/** Who asked, as the API names them: the email, or the `sub` when the token had none. */
export function requesterOf(request: PackRequest): string {
  return request.requested_by_email ?? request.requested_by;
}

/** The version agents use now; before the first installation, the one of the release. */
export function shownVersion(pack: Pack): string {
  return pack.installed_version ?? pack.version;
}

/** Value of each parameter in use, or its default before the first installation. */
export function currentConfig(pack: Pack): Record<string, string> {
  return Object.fromEntries(pack.params.map((param) => [param.key, param.value ?? param.default]));
}

export interface ParamChange {
  key: string;
  from: string;
  to: string;
}

/** What a parameter request changes against the configuration in use. */
export function paramChanges(pack: Pack, config: Readonly<Record<string, string>>): ParamChange[] {
  const current = currentConfig(pack);
  return Object.entries(config).flatMap(([key, to]) => {
    const from = current[key];
    return from !== undefined && from !== to ? [{ key, from, to }] : [];
  });
}

/**
 * AWS permissions this server adds to what the enabled ones already use (design `newPerms`):
 * what the approver reads before approving.
 */
export function newPermissions(server: Server, servers: readonly Server[]): string[] {
  const inUse = new Set(
    servers
      .filter((other) => other.id !== server.id && statusOf(other) === 'enabled')
      .flatMap((other) => other.permissions),
  );
  return server.permissions.filter((permission) => !inUse.has(permission));
}

/** Tool of an update by name: the API lists names, the access comes from the release's tools. */
export function isWriteTool(server: Server, name: string): boolean {
  return server.tools.some((tool) => tool.name === name && tool.access === 'write');
}

export const REASON_MAX_LENGTH = 500;
export const QUERY_MAX_LENGTH = 200;
