/**
 * Mock routes of the Bandeja (D83): GET /inbox, GET /inbox/unread, POST /inbox/read-all and
 * PUT /inbox/{kind}/{id}. As the API, approvals are the requests the mock user can sign now
 * (from the approvals mock) and run notices are the runs of the mock user's tasks that completed
 * or failed (from the tasks mock), with the first line of the report. Read and archived state is
 * kept in memory. The response follows the generated contract (packages/ts/api-client).
 */
import { signableApprovals } from './approvals.ts';
import { readBody, sendError, sendJson, type ApiHandler } from './http.ts';
import { endedRunsOfMine } from './tasks.ts';

const PAGE = 20;
const ITEM_ROUTE = /^\/inbox\/(approval|run)\/([0-9]{13}[0-9a-f]{16}|[0-9a-f]{32})$/;
const VIEWS = new Set(['all', 'unread', 'approvals', 'archived']);
const state = new Map<string, { read: boolean; archived: boolean }>();

function firstLine(report: string | null): string | null {
  for (const line of (report ?? '').split('\n')) {
    const text = line
      .replace(/^#+\s*/, '')
      .replace(/\*\*|`/g, '')
      .trim();
    if (text) return text.slice(0, 200);
  }
  return null;
}

function items() {
  const approvals = signableApprovals().map((approval) => {
    const seen = state.get(`approval:${approval.approval_id}`);
    return {
      kind: 'approval' as const,
      item_id: approval.approval_id,
      agent_id: approval.agent_id,
      agent_name: approval.agent_name,
      at: approval.created_at,
      read: seen?.read ?? false,
      archived: seen?.archived ?? false,
      approval,
      run: null,
    };
  });
  const runs = endedRunsOfMine()
    .map(({ task, run }) => {
      const at = run.ended_at ?? run.queued_at;
      const itemId = `${String(Date.parse(at)).padStart(13, '0')}${run.run_id.slice(0, 16)}`;
      const seen = state.get(`run:${itemId}`);
      const ok = run.status === 'ok';
      return {
        kind: 'run' as const,
        item_id: itemId,
        agent_id: task.agent_id,
        agent_name: task.agent_id === 'finops' ? 'FinOps' : null,
        at,
        read: seen?.read ?? false,
        archived: seen?.archived ?? false,
        approval: null,
        run: {
          task_id: task.task_id,
          run_id: run.run_id,
          task_name: task.name,
          ok,
          summary: ok ? firstLine(run.result) : null,
          reason: ok ? null : run.reason,
        },
      };
    })
    .sort((a, b) => b.item_id.localeCompare(a.item_id));
  return { approvals, runs };
}

function unread(): number {
  const { approvals, runs } = items();
  return Math.min(99, [...approvals, ...runs].filter((i) => !i.read && !i.archived).length);
}

function visible(item: { read: boolean; archived: boolean; kind: string }, view: string) {
  if (view === 'archived') return item.archived;
  if (item.archived) return false;
  if (view === 'unread') return !item.read;
  if (view === 'approvals') return item.kind === 'approval';
  return true;
}

export const handleInbox: ApiHandler = async (req, res, path, url) => {
  if (!path.startsWith('/inbox')) return false;
  if (path === '/inbox' && req.method === 'GET') {
    const view = url.searchParams.get('view') ?? 'all';
    const cursor = url.searchParams.get('cursor');
    if (!VIEWS.has(view) || (cursor !== null && !/^[0-9]{13}[0-9a-f]{16}$/.test(cursor))) {
      sendError(res, 422, 'invalid_request', 'invalid query');
      return true;
    }
    const { approvals, runs } = items();
    const after = runs.filter((i) => visible(i, view) && (cursor === null || i.item_id < cursor));
    const page = after.slice(0, PAGE);
    sendJson(res, 200, {
      items: [...(cursor === null ? approvals.filter((i) => visible(i, view)) : []), ...page],
      next_cursor: after.length > PAGE ? (page.at(-1)?.item_id ?? null) : null,
      unread: unread(),
      can_decide: true,
    });
    return true;
  }
  if (path === '/inbox/unread' && req.method === 'GET') {
    sendJson(res, 200, { unread: unread() });
    return true;
  }
  if (path === '/inbox/read-all' && req.method === 'POST') {
    const { approvals, runs } = items();
    for (const item of [...approvals, ...runs]) {
      const key = `${item.kind}:${item.item_id}`;
      state.set(key, { read: true, archived: state.get(key)?.archived ?? false });
    }
    sendJson(res, 200, { unread: unread() });
    return true;
  }
  const match = ITEM_ROUTE.exec(path);
  if (match && req.method === 'PUT') {
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse((await readBody(req)) || '{}');
      const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
      if (!Array.isArray(parsed) && keys.every((key) => key === 'read' || key === 'archived')) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = null;
    }
    const read = body?.read;
    const archived = body?.archived;
    if (
      !body ||
      (read === undefined && archived === undefined) ||
      (read !== undefined && typeof read !== 'boolean') ||
      (archived !== undefined && typeof archived !== 'boolean')
    ) {
      sendError(res, 422, 'invalid_request', 'read or archived is required');
      return true;
    }
    const { approvals, runs } = items();
    const item = [...approvals, ...runs].find((i) => i.kind === match[1] && i.item_id === match[2]);
    if (!item) {
      sendError(res, 404, 'not_found', 'notice not found');
      return true;
    }
    const key = `${item.kind}:${item.item_id}`;
    const next = {
      read: archived === true ? true : typeof read === 'boolean' ? read : item.read,
      archived: typeof archived === 'boolean' ? archived : item.archived,
    };
    state.set(key, next);
    sendJson(res, 200, { ...item, ...next });
    return true;
  }
  return false;
};
