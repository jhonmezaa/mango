import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { zGetCatalogResponse } from '@mango/api-client/schemas';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { catalogTool, handleMcpCatalog } from './mcpCatalog.ts';

let server: Server;
let origin = '';

async function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${origin}${path}`, init);
  const answer: unknown = await response.json();
  return { status: response.status, body: answer };
}

async function catalog() {
  return zGetCatalogResponse.parse((await call('GET', '/mcp/catalog')).body);
}

async function packOf(id: string) {
  const item = (await catalog()).items.find((candidate) => candidate.id === id);
  if (!item?.pack) throw new Error(`no pack ${id}`);
  return { item, pack: item.pack };
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

beforeAll(async () => {
  // The handler alone: authentication is covered by mockBackend.test.ts.
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleMcpCatalog(req, res, url.pathname, url).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  vi.useRealTimers();
});

/** Moves the clock past the mock provisioner. */
function finishProvisioning() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 5000);
}

describe('mock MCP catalog', () => {
  it('answers the catalog with the generated contract, one pack in each status', async () => {
    const { items, max_enabled_packs: max } = await catalog();
    expect(max).toBe(10);
    expect(items.find((item) => item.id === 'cost-explorer')).toMatchObject({
      kind: 'connector',
      enabled: true,
      pack: null,
    });
    const statuses = new Set(items.flatMap((item) => (item.pack ? [item.pack.status] : [])));
    expect([...statuses].sort()).toEqual(
      ['available', 'disabled', 'enabled', 'error', 'installing', 'pending'].sort(),
    );
    // Pack tools have no description: the signed manifest only carries name and access.
    for (const item of items.filter((candidate) => candidate.kind === 'pack')) {
      expect(item.tools.every((tool) => tool.description === '')).toBe(true);
    }
    expect(items.find((item) => item.id === 'aws-pricing')?.agents).toEqual([
      expect.objectContaining({ name: 'Savings Plans' }),
    ]);
  });

  it('serves only the tools of the installed version while an update waits', async () => {
    const { item, pack } = await packOf('ec2-operations');
    expect(pack.update?.added_tools).toEqual(['reboot_instances']);
    expect(item.tools.filter((tool) => !tool.enabled).map((tool) => tool.name)).toEqual([
      'reboot_instances',
    ]);
    expect(catalogTool('ec2-operations.stop_instances')?.enabled).toBe(true);
    expect(catalogTool('ec2-operations.reboot_instances')?.enabled).toBe(false);
    expect(catalogTool('aws-billing.list_invoices')?.enabled).toBe(false);
    expect(catalogTool('nope.tool')).toBeNull();
  });

  it('validates path, body and lock version before anything else', async () => {
    expect((await call('POST', '/mcp/unknown/retry', { version: 0 })).status).toBe(404);
    expect((await call('POST', '/mcp/BAD_ID/retry', { version: 0 })).status).toBe(404);
    const extra = await call('POST', '/mcp/aws-documentation/enablements', {
      version: 0,
      arn: 'arn:aws:iam::1:role/x',
    });
    expect(extra.status).toBe(422);
    const stale = await call('POST', '/mcp/aws-documentation/enablements', { version: 9 });
    expect([stale.status, errorCode(stale.body)]).toEqual([409, 'version_conflict']);
  });

  it('only accepts parameters of the manifest with values of its list', async () => {
    const { pack } = await packOf('aws-support');
    for (const config of [{ region: 'mars-1' }, { size: 'xl' }, { region: 1 }]) {
      const refused = await call('POST', '/mcp/aws-support/enablements', {
        version: pack.lock_version,
        config,
      });
      expect([refused.status, errorCode(refused.body)]).toEqual([422, 'invalid_config']);
    }
  });

  it('keeps the requester from deciding: they can only withdraw', async () => {
    const created = await call('POST', '/mcp/aws-documentation/enablements', {
      version: 0,
      reason: 'Guías',
    });
    expect(created.status).toBe(201);
    const { pack } = await packOf('aws-documentation');
    expect(pack).toMatchObject({ status: 'pending', lock_version: 1 });
    expect(pack.pending).toMatchObject({ kind: 'enable', own: true, reason: 'Guías' });
    const base = `/mcp/aws-documentation/enablements/${pack.pending?.change_id ?? ''}`;

    const second = await call('POST', '/mcp/aws-documentation/enablements', { version: 1 });
    expect([second.status, errorCode(second.body)]).toEqual([409, 'pending_exists']);
    const approve = await call('POST', `${base}/approve`, {});
    expect([approve.status, errorCode(approve.body)]).toEqual([403, 'same_approver']);
    const reject = await call('POST', `${base}/reject`, { reason: 'no' });
    expect([reject.status, errorCode(reject.body)]).toEqual([403, 'use_withdraw']);

    expect((await call('POST', `${base}/withdraw`, {})).status).toBe(200);
    expect((await packOf('aws-documentation')).pack).toMatchObject({
      status: 'available',
      pending: null,
    });
  });

  it('needs a reason to reject a request to enable, and records the rejection', async () => {
    const { pack } = await packOf('aws-billing');
    const base = `/mcp/aws-billing/enablements/${pack.pending?.change_id ?? ''}`;
    expect(pack.pending?.own).toBe(false);
    const withdrawn = await call('POST', `${base}/withdraw`, {});
    expect([withdrawn.status, errorCode(withdrawn.body)]).toEqual([403, 'not_requester']);
    const bare = await call('POST', `${base}/reject`, {});
    expect([bare.status, errorCode(bare.body)]).toEqual([422, 'reason_required']);
    expect((await call('POST', `${base}/reject`, { reason: 'Falta el responsable' })).status).toBe(
      200,
    );
    const after = (await packOf('aws-billing')).pack;
    expect(after).toMatchObject({ status: 'available', pending: null });
    expect(after.last_rejected).toMatchObject({ kind: 'enable', reason: 'Falta el responsable' });
  });

  it('installs what another admin asked for once it is approved', async () => {
    const { pack } = await packOf('aws-health');
    expect(pack.pending).toMatchObject({ kind: 'params', config: { region: 'eu-west-1' } });
    const approved = await call(
      'POST',
      `/mcp/aws-health/enablements/${pack.pending?.change_id ?? ''}/approve`,
      {},
    );
    expect(approved.status).toBe(200);
    const during = await packOf('aws-health');
    // What was installed keeps serving while the change is applied (D26).
    expect(during.pack).toMatchObject({ status: 'installing', pending: null });
    expect(during.item.enabled).toBe(true);
    expect(during.pack.params[0]?.value).toBe('us-east-1');

    finishProvisioning();
    const after = (await packOf('aws-health')).pack;
    expect(after.status).toBe('enabled');
    expect(after.params[0]?.value).toBe('eu-west-1');
  });

  it('asks for a parameter change only when it changes something and no update waits', async () => {
    finishProvisioning();
    const { pack } = await packOf('aws-health');
    const same = await call('POST', '/mcp/aws-health/params', {
      version: pack.lock_version,
      config: { region: 'eu-west-1' },
    });
    expect([same.status, errorCode(same.body)]).toEqual([422, 'no_change']);
    const changed = await call('POST', '/mcp/aws-health/params', {
      version: pack.lock_version,
      config: { region: 'us-west-2' },
    });
    expect(changed.status).toBe(201);
    expect((await packOf('aws-health')).pack).toMatchObject({
      status: 'enabled',
      pending: { kind: 'params', own: true },
    });
  });

  it('retries a failed installation', async () => {
    const { pack } = await packOf('cost-anomaly');
    expect(pack).toMatchObject({ status: 'error', failed_step: 'create_role' });
    const wrong = await call('POST', '/mcp/aws-pricing/retry', { version: 2 });
    expect([wrong.status, errorCode(wrong.body)]).toEqual([409, 'invalid_state']);
    expect(
      (await call('POST', '/mcp/cost-anomaly/retry', { version: pack.lock_version })).status,
    ).toBe(200);
    expect((await packOf('cost-anomaly')).pack).toMatchObject({
      status: 'installing',
      failed_step: null,
    });
    finishProvisioning();
    expect((await packOf('cost-anomaly')).item.enabled).toBe(true);
  });

  it('disables a pack with a reason; its tools stop being served', async () => {
    const { pack } = await packOf('aws-pricing');
    const bare = await call('DELETE', '/mcp/aws-pricing', { version: pack.lock_version });
    expect(bare.status).toBe(422);
    const disabled = await call('DELETE', '/mcp/aws-pricing', {
      version: pack.lock_version,
      reason: 'Ya no se usa',
    });
    expect(disabled.status).toBe(200);
    const during = await packOf('aws-pricing');
    expect(during.pack).toMatchObject({ status: 'disabling', disable_reason: 'Ya no se usa' });
    // The affected agents are still listed after the pack is gone.
    expect(during.item.agents).toHaveLength(1);

    finishProvisioning();
    const after = await packOf('aws-pricing');
    expect(after.pack).toMatchObject({ status: 'disabled', installed_version: null });
    expect(after.item.enabled).toBe(false);
    expect(after.item.tools.every((tool) => !tool.enabled)).toBe(true);
    expect(catalogTool('aws-pricing.get_products')?.enabled).toBe(false);
  });
});
