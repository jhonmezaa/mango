import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../../api/client';
import {
  MAX_RUNNING,
  applyEvent,
  blockOfError,
  blockOfEvent,
  type Block,
  type Column,
  type Entry,
  type Run,
} from './model';

interface Queued {
  runId: string;
  key: string;
  input: string;
  column: Column;
}

/**
 * The tests of the screen (design `pump`/`tick`): a local queue that runs at most two at once.
 * Nothing is kept: the runs live in this state and are lost when the screen goes (D91).
 */
export function usePlaygroundRuns(
  api: ApiClient,
  agentId: string | null,
  onBlock: (block: Block) => void,
) {
  const [runs, setRuns] = useState<Run[]>([]);
  const queue = useRef<Queued[]>([]);
  const active = useRef(0);
  const controllers = useRef(new Map<string, AbortController>());
  // A clear starts a new generation: tests of the old one no longer touch the state.
  const generation = useRef(0);
  const blockRef = useRef(onBlock);
  // The end of a test starts the next one: through a ref, as `pump` cannot name itself.
  const next = useRef<() => void>(() => undefined);
  useEffect(() => {
    blockRef.current = onBlock;
  }, [onBlock]);

  const update = useCallback((runId: string, key: string, change: (entry: Entry) => Entry) => {
    setRuns((list) =>
      list.map((run) =>
        run.id !== runId
          ? run
          : {
              ...run,
              entries: run.entries.map((entry) => (entry.key === key ? change(entry) : entry)),
            },
      ),
    );
  }, []);

  /** A block stops what is waiting too: those tests would get the same answer. */
  const failQueued = useCallback(() => {
    const waiting = queue.current;
    queue.current = [];
    for (const item of waiting)
      update(item.runId, item.key, (entry) => ({ ...entry, state: 'error' }));
  }, [update]);

  const pump = useCallback(() => {
    if (agentId === null) return;
    while (active.current < MAX_RUNNING && queue.current.length > 0) {
      const item = queue.current.shift();
      if (!item) break;
      active.current += 1;
      const mine = generation.current;
      const controller = new AbortController();
      controllers.current.set(item.key, controller);
      update(item.runId, item.key, (entry) => ({ ...entry, state: 'running' }));
      const turn = { settled: false };
      const { column } = item;
      api
        .streamPlayground({
          agentId,
          version: column.version,
          revision: column.revision,
          message: item.input,
          overrides: column.overrides,
          signal: controller.signal,
          onEvent: (event) => {
            if (generation.current !== mine) return;
            if (event.type === 'done' || event.type === 'error') turn.settled = true;
            update(item.runId, item.key, (entry) => applyEvent(entry, event, performance.now()));
            if (event.type === 'error') {
              const block = blockOfEvent(event);
              if (block) {
                blockRef.current(block);
                failQueued();
              }
            }
          },
        })
        .catch((error: unknown) => {
          if (generation.current !== mine || controller.signal.aborted) return;
          const block = blockOfError(error, Date.now());
          if (block) {
            blockRef.current(block);
            failQueued();
          }
        })
        .finally(() => {
          controllers.current.delete(item.key);
          if (generation.current !== mine) return;
          if (!turn.settled && !controller.signal.aborted) {
            update(item.runId, item.key, (entry) =>
              entry.state === 'running' ? { ...entry, state: 'error' } : entry,
            );
          }
          active.current = Math.max(0, active.current - 1);
          next.current();
        });
    }
  }, [agentId, api, failQueued, update]);

  useEffect(() => {
    next.current = pump;
  }, [pump]);

  /** One question: one test per column, queued. */
  const start = useCallback(
    (input: string, columns: readonly Column[]) => {
      const runId = crypto.randomUUID();
      const entries: Entry[] = columns.map((column) => ({
        key: crypto.randomUUID(),
        column,
        state: 'queued',
        text: '',
        tools: [],
        writes: [],
        connections: [],
        connectionAt: null,
        done: null,
      }));
      setRuns((list) => [{ id: runId, input, entries }, ...list]);
      for (const entry of entries) {
        queue.current.push({ runId, key: entry.key, input, column: entry.column });
      }
      pump();
    },
    [pump],
  );

  const clear = useCallback(() => {
    generation.current += 1;
    queue.current = [];
    active.current = 0;
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    setRuns([]);
  }, []);

  // A different agent, or leaving the screen, ends every test of the old one.
  useEffect(() => clear, [agentId, clear]);

  return { runs, start, clear };
}
