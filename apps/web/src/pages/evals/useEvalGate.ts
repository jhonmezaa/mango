import { useEffect, useState } from 'react';

import type { ApiClient } from '../../api/client';
import { gateBlocks, gateOf, type Gate, type Suite } from './model';

/** While a required suite runs on the version, where it stands is read this often. */
const GATE_POLL_MS = 5_000;

/**
 * The suites of the agent of a version in review (design `EvalGate`, D26). Null while they load
 * or when the account may not read them: the server's approval gate decides anyway (409
 * `evals_not_passing`), this only explains it before the approver tries.
 */
export function useEvalGate(
  api: ApiClient,
  agentId: string,
  contentHash: string | null,
): Gate | null {
  const [suites, setSuites] = useState<Suite[] | null>(null);
  const [tick, setTick] = useState(0);
  const running = suites?.some((suite) => suite.required && suite.active_run) ?? false;

  useEffect(() => {
    const controller = new AbortController();
    api.call('getEvals', { query: { agent_id: agentId } }, { signal: controller.signal }).then(
      (list) => {
        if (!controller.signal.aborted) setSuites(list.suites);
      },
      () => {
        if (!controller.signal.aborted) setSuites(null);
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, agentId, tick]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') setTick((n) => n + 1);
    }, GATE_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [running]);

  return suites ? gateOf(suites, contentHash) : null;
}

/** The line the gate adds to «No cumple las reglas de publicación» (design `errs` «evals»). */
export function gateRule(gate: Gate | null): 'unfinished' | 'failing' | null {
  if (!gate || !gateBlocks(gate)) return null;
  return gate.failing.length &&
    !gate.running.length &&
    !gate.waiting.length &&
    !gate.unfinished.length
    ? 'failing'
    : 'unfinished';
}
