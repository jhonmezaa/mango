import { useEffect, useState } from 'react';

import type { Budgets } from '../../api/adminSchemas';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import {
  AGENT_ID_PATTERN,
  blankDefinition,
  type BuilderContext,
  type Definition,
  type OrgNode,
  type Quotas,
  type Version,
} from './model';

/** What the form starts from (the design's "revision"). */
export interface Draft {
  /** `change`: a new version of a published agent. `new`: an agent that was never published. */
  kind: 'new' | 'change';
  agentId: string | null;
  /** Stored version being edited; null until the first save. */
  version: Version | null;
  /** Published definition a change is compared against. */
  base: Definition | null;
  initial: Definition;
}

export interface BuilderData {
  context: BuilderContext;
  /** Published agents the caller can see, for «Reporta a». */
  nodes: OrgNode[];
  quotas: Quotas;
  /** Null for non-admins and when Presupuestos did not answer: the limit is then not shown. */
  budgets: Budgets | null;
  draft: Draft;
}

export type LoadError = 'forbidden' | 'not_found' | 'failed';
export type LoadState =
  { kind: 'loading' } | { kind: 'ready'; data: BuilderData } | { kind: 'error'; error: LoadError };

function draftOf(version: Version): Draft {
  const published = version.agent.published_version;
  return {
    kind: published === null ? 'new' : 'change',
    agentId: version.agent_id,
    version,
    // For the published (or retired) version itself the server sends no base.
    base: version.base ?? (published === version.version ? version.definition : null),
    initial: version.definition,
  };
}

/** What the URL names: an agent and, optionally, one of its versions. */
export interface Target {
  agentId: string;
  version: number | null;
}

/**
 * `/admin`, `/admin/<agentId>` or `/admin/<agentId>/<version>`: null for a new agent and
 * `'invalid'` for anything else. Checked here, before any request is built from the URL.
 */
export function parseTarget(splat: string): Target | null | 'invalid' {
  const parts = splat.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const [agentId = '', version] = parts;
  if (parts.length > 2 || !AGENT_ID_PATTERN.test(agentId)) return 'invalid';
  if (version === undefined) return { agentId, version: null };
  return /^[1-9]\d{0,5}$/.test(version) ? { agentId, version: Number(version) } : 'invalid';
}

/**
 * The version the URL edits, as in the design. A version that is not the published one is
 * edited as it is. Otherwise: the caller's open version of that agent, else the one somebody
 * else left open, else a change that starts from the published content and is only stored on
 * the first save.
 */
async function loadDraft(
  api: ApiClient,
  { agentId, version }: Target,
  mine: Promise<{ items: { agent_id: string; version: number }[] }>,
): Promise<Draft> {
  const read = (number: number) =>
    api.call('readVersion', { path: { agent_id: agentId, version: number } });
  let published: Version;
  if (version !== null) {
    const requested = await read(version);
    if (requested.status !== 'published') return draftOf(requested);
    published = requested;
  } else {
    const own = (await mine).items.find((item) => item.agent_id === agentId);
    if (own) return draftOf(await read(own.version));
    const agent = await api.call('getAgent', { path: { agent_id: agentId } });
    published = await read(agent.version);
  }
  const open = published.agent.open_version;
  if (open !== null && open !== published.version) return draftOf(await read(open));
  if (published.status !== 'published') return draftOf(published);
  return {
    kind: 'change',
    agentId,
    version: null,
    base: published.definition,
    initial: published.definition,
  };
}

async function load(api: ApiClient, target: Target | null, isAdmin: boolean): Promise<BuilderData> {
  // Independent reads go out together; only the draft waits for `mine`.
  const mine = api.call('getMine');
  const [mineOut, models, catalog, groups, org, budgets, stored] = await Promise.all([
    mine,
    api.call('getModels'),
    api.call('getCatalog'),
    api.call('listGroups'),
    api.call('getOrg'),
    // Presupuestos is an admin API; without it the page only hides the amount.
    isAdmin ? api.getBudgets().catch(() => null) : null,
    target === null ? null : loadDraft(api, target, mine),
  ]);
  const context: BuilderContext = {
    models: models.items,
    catalog: catalog.items,
    groups: groups.items,
  };
  const draft: Draft = stored ?? {
    kind: 'new',
    agentId: null,
    version: null,
    base: null,
    initial: blankDefinition(context),
  };
  return { context, nodes: org.nodes, quotas: mineOut.quotas, budgets, draft };
}

function loadError(error: unknown): LoadError {
  if (error instanceof ApiError && error.status === 403) return 'forbidden';
  if (error instanceof ApiError && error.status === 404) return 'not_found';
  return 'failed';
}

/** Loads everything the Builder shows for a target taken from the URL (`parseTarget`). */
export function useBuilderData(
  api: ApiClient,
  target: Target | null | 'invalid',
  isAdmin: boolean,
  enabled: boolean,
): { state: LoadState; retry: () => void } {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const valid = target !== 'invalid';
  const agentId = valid && target ? target.agentId : null;
  const version = valid && target ? target.version : null;

  useEffect(() => {
    if (!enabled || !valid) return;
    let cancelled = false;
    load(api, agentId === null ? null : { agentId, version }, isAdmin).then(
      (data) => {
        if (!cancelled) setState({ kind: 'ready', data });
      },
      (error: unknown) => {
        if (!cancelled) setState({ kind: 'error', error: loadError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, agentId, version, isAdmin, enabled, valid, attempt]);

  const retry = () => {
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  };
  return { state: valid ? state : { kind: 'error', error: 'not_found' }, retry };
}
