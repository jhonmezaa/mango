import { useCallback, useEffect, useState } from 'react';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { BuilderContext } from '../agentBuilder/model';
import { draftSources, publishedSources, type Source } from './model';

export interface PlaygroundData {
  drafts: Source[];
  published: Source[];
  context: BuilderContext;
  /** Skill names by id, for the read-only list; null when Skills did not answer. */
  skillNames: ReadonlyMap<string, string> | null;
}

export type DataState =
  { kind: 'loading' } | { kind: 'ready'; data: PlaygroundData } | { kind: 'error' };

async function load(api: ApiClient, isAdmin: boolean): Promise<PlaygroundData> {
  const [mine, agents, models, catalog, groups, skills] = await Promise.all([
    // Only agent creators have drafts of their own: anyone else has none to list.
    api.call('getMine').catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 403) return { items: [] };
      throw error;
    }),
    api.call('getAgents'),
    api.call('getModels'),
    api.call('getCatalog'),
    api.call('listGroups'),
    // Names only: without them each skill shows its id.
    api.call('getSkills').then(
      (data) => new Map(data.items.map((skill) => [skill.id, skill.name])),
      () => null,
    ),
  ]);
  return {
    drafts: draftSources(mine.items),
    published: publishedSources(agents.items, isAdmin),
    // Knowledge bases are not read: the Playground only checks what the Builder checks before
    // sending, and the server checks the rest.
    context: {
      models: models.items,
      catalog: catalog.items,
      groups: groups.items,
      knowledge: null,
    },
    skillNames: skills,
  };
}

/** What the Playground lists. `refresh` reads again without leaving the screen. */
export function usePlaygroundData(api: ApiClient, isAdmin: boolean) {
  const [state, setState] = useState<DataState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load(api, isAdmin).then(
      (data) => {
        if (!cancelled) setState({ kind: 'ready', data });
      },
      () => {
        if (!cancelled) setState({ kind: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, isAdmin, attempt]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);
  /** Reads again while the screen stays; resolves once the new list is in place. */
  const refresh = useCallback(async () => {
    try {
      const data = await load(api, isAdmin);
      setState({ kind: 'ready', data });
    } catch {
      // The screen keeps the list it has; the next action reads again.
    }
  }, [api, isAdmin]);
  return { state, retry, refresh };
}
