import { describe, expect, it } from 'vitest';

import {
  NO_FILTERS,
  currentConfig,
  dataModeOf,
  isCentralTool,
  requiredServices,
  filterServers,
  filterTools,
  hasFilters,
  isWriteTool,
  newPermissions,
  paramChanges,
  pendingRequests,
  shownVersion,
  statusOf,
  toolRows,
  writeTools,
} from './model';
import {
  ALL,
  billing,
  costExplorer,
  documentation,
  ec2,
  health,
  pack,
  pricing,
  server,
  support,
  tool,
} from './testFixtures';

describe('status', () => {
  it('takes the status of a pack and treats a connector as installed', () => {
    expect(statusOf(billing)).toBe('pending');
    expect(statusOf(costExplorer)).toBe('enabled');
    expect(statusOf({ ...costExplorer, enabled: false })).toBe('disabled');
  });
});

describe('catalog filters', () => {
  const names = (list: typeof ALL) => list.map((item) => item.name);

  it('lists packs first and then by name (design order)', () => {
    expect(names(filterServers(ALL, NO_FILTERS))).toEqual([
      'AWS Billing',
      'AWS Documentation',
      'AWS Health',
      'AWS Pricing',
      'AWS Support',
      'CloudWatch Logs Insights',
      'Cost Anomaly Detection',
      'EC2 Operations',
      'AWS Cost Explorer',
    ]);
  });

  it('filters by kind, status and data level', () => {
    expect(names(filterServers(ALL, { ...NO_FILTERS, kind: 'connector' }))).toEqual([
      'AWS Cost Explorer',
    ]);
    expect(names(filterServers(ALL, { ...NO_FILTERS, status: 'enabled' }))).toEqual([
      'AWS Health',
      'AWS Pricing',
      'EC2 Operations',
      'AWS Cost Explorer',
    ]);
    expect(names(filterServers(ALL, { ...NO_FILTERS, level: 'write' }))).toEqual([
      'EC2 Operations',
    ]);
    expect(filterServers(ALL, { ...NO_FILTERS, level: 'internal' })).toEqual([]);
  });

  it('searches the name, the id, the description and the tool names', () => {
    const search = (query: string) => names(filterServers(ALL, { ...NO_FILTERS, query }));
    expect(search('  PRICING ')).toEqual(['AWS Pricing']);
    expect(search('stop_instances')).toEqual(['EC2 Operations']);
    expect(search('facturas')).toEqual(['AWS Billing']);
    expect(search('cloudwatch-logs')).toEqual(['CloudWatch Logs Insights']);
  });

  it('knows when a filter is on', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, query: '  ' })).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, kind: 'pack' })).toBe(true);
  });
});

describe('tools', () => {
  const rows = toolRows(ALL);
  const all = { query: '', kind: 'all', onlyEnabled: false } as const;

  it('lists every tool with its server', () => {
    expect(rows).toHaveLength(ALL.reduce((total, item) => total + item.tools.length, 0));
    expect(writeTools(ec2)).toBe(2);
    expect(writeTools(pricing)).toBe(0);
  });

  it('filters by access and by what an agent can use now', () => {
    const refs = (filters: Parameters<typeof filterTools>[1]) =>
      filterTools(rows, filters).map(({ tool }) => tool.ref);
    expect(refs({ ...all, kind: 'write' })).toEqual([
      'ec2-operations.stop_instances',
      'ec2-operations.reboot_instances',
    ]);
    // The tool the update adds is listed, but the installed version does not serve it.
    expect(refs({ ...all, kind: 'write', onlyEnabled: true })).toEqual([
      'ec2-operations.stop_instances',
    ]);
    expect(refs({ ...all, query: 'health' })).toEqual(['aws-health.describe_events']);
  });

  it('knows which tools of an update write', () => {
    expect(isWriteTool(ec2, 'reboot_instances')).toBe(true);
    expect(isWriteTool(ec2, 'describe_instances')).toBe(false);
    expect(isWriteTool(ec2, 'start_instances')).toBe(false);
  });
});

describe('requests and parameters', () => {
  it('collects the pending request of each pack', () => {
    expect(
      pendingRequests(ALL).map(({ server: item, request }) => [item.id, request.kind]),
    ).toEqual([
      ['aws-billing', 'enable'],
      ['ec2-operations', 'update'],
      ['aws-health', 'params'],
    ]);
    expect(pendingRequests([pricing, costExplorer])).toEqual([]);
  });

  it('shows the installed version, or the release one before the first installation', () => {
    expect(shownVersion(pack({ version: '2.0.0', installed_version: '1.0.0' }))).toBe('1.0.0');
    expect(shownVersion(pack({ version: '2.0.0' }))).toBe('2.0.0');
  });

  it('uses the default of a parameter until the pack is installed', () => {
    expect(currentConfig(documentation.pack ?? pack())).toEqual({ region: 'us-east-1' });
  });

  it('lists what a parameter request changes', () => {
    const installed = health.pack ?? pack();
    expect(paramChanges(installed, { region: 'eu-west-1' })).toEqual([
      { key: 'region', from: 'us-east-1', to: 'eu-west-1' },
    ]);
    expect(paramChanges(installed, { region: 'us-east-1', unknown: 'x' })).toEqual([]);
  });
});

describe('new permissions', () => {
  it('leaves out what the enabled servers already use', () => {
    expect(newPermissions(billing, ALL)).toEqual(['billing:GetBillingData']);
  });

  it('counts every permission when nothing else uses them', () => {
    expect(newPermissions(billing, [billing, support])).toEqual([
      'billing:GetBillingData',
      'ce:GetCostAndUsage',
    ]);
    const other = server({ id: 'x', name: 'X', permissions: ['ce:GetCostAndUsage'] });
    // A server that is not enabled does not count.
    expect(newPermissions(billing, [billing, other])).toHaveLength(2);
  });
});

describe('account data mode and opt-in services', () => {
  it('has a mode only for account data: per user, or central otherwise', () => {
    expect(dataModeOf(costExplorer)).toBe('user');
    expect(dataModeOf(billing)).toBe('central');
    expect(dataModeOf(pricing)).toBeNull();
    // Write packs have no mode either, whatever their identity mode.
    expect(dataModeOf(server({ id: 'w', name: 'W', data_tier: 'write' }))).toBeNull();
  });

  it('tells the tools only central users may call', () => {
    const [byUser, central] = costExplorer.tools;
    expect(byUser && isCentralTool(byUser)).toBe(false);
    expect(central && isCentralTool(central)).toBe(true);
  });

  it('names each required AWS service once', () => {
    const item = server({
      id: 'p',
      name: 'P',
      tools: [
        tool('p', 'a', { requires_service: 'Compute Optimizer' }),
        tool('p', 'b', { requires_service: 'Compute Optimizer' }),
        tool('p', 'c', { requires_service: 'Cost Optimization Hub' }),
        tool('p', 'd'),
      ],
    });
    expect(requiredServices(item)).toEqual(['Compute Optimizer', 'Cost Optimization Hub']);
    expect(requiredServices(pricing)).toEqual([]);
  });
});
