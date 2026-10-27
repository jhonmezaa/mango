import { ApiError } from '../../api/errors';
import type { PlaygroundDone, PlaygroundEvent } from '../../api/playgroundEvents';
import type { OperationOutput } from '../../api/operations';
import type { Definition, Model, Version } from '../agentBuilder/model';

// Data and rules of the Playground (design playground.jsx, D91). What the page hides or blocks
// here is only a hint: the API decides who may test, what and how much (EditAgent, budgets,
// limits, secrets).

export type MineItem = OperationOutput<'getMine'>['items'][number];
export type AgentItem = OperationOutput<'getAgents'>['items'][number];

/** Design `PG_FIXED`, by their keys in the texts; «Prueba de seguridad» goes apart. */
export const SAMPLE_KEYS = ['tools', 'example', 'missing'] as const;
/** At most two tests at once (D91: `CONCURRENT_RUNS`); the rest wait in the queue. */
export const MAX_RUNNING = 2;

/** One thing to test: a draft of the caller or a published agent they edit. */
export interface Source {
  key: string;
  kind: 'draft' | 'published';
  agentId: string;
  version: number;
  name: string;
  /** Drafts only: rejected drafts carry the reviewer's reason. */
  rejection: string | null;
}

export function draftSources(items: readonly MineItem[]): Source[] {
  return items
    .filter((item) => item.status === 'draft')
    .map((item) => ({
      key: `draft:${item.agent_id}:${String(item.version)}`,
      kind: 'draft',
      agentId: item.agent_id,
      version: item.version,
      name: item.name,
      rejection: item.rejection_reason,
    }));
}

/** Published agents the caller edits: every one for an admin, otherwise the ones they created. */
export function publishedSources(items: readonly AgentItem[], isAdmin: boolean): Source[] {
  return items
    .filter((item) => item.status === 'published' && (isAdmin || item.is_mine))
    .map((item) => ({
      key: `published:${item.id}`,
      kind: 'published',
      agentId: item.id,
      version: item.version,
      name: item.name,
      rejection: null,
    }));
}

/** Models the test may use: the enabled ones and, with tools or knowledge bases, only those that call tools. */
export function testModels(models: readonly Model[], definition: Definition): Model[] {
  const usesTools = definition.tools.length > 0 || definition.knowledge_bases.length > 0;
  return models.filter((model) => !usesTools || model.supports_tools);
}

/** The definition with what changed on screen, as it would be saved (design `snap`). */
export function withChanges(definition: Definition, prompt: string, model: string): Definition {
  const allowed = definition.allowed_models.includes(model)
    ? definition.allowed_models
    : [...definition.allowed_models, model];
  return { ...definition, system_prompt: prompt, model, allowed_models: allowed };
}

/** The published version a draft or a published agent is compared with («Con publicado»). */
export function publishedVersionOf(version: Version): number | null {
  return version.agent.published_version;
}

// --- Runs ----------------------------------------------------------------------------------------

/** What one column runs: a stored version and the changes that go with it. */
export interface Column {
  label: { key: 'published' | 'draft' | 'changes' | 'model'; model?: string } | null;
  version: number;
  revision: number | null;
  model: string;
  overrides: { systemPrompt?: string; model?: string; temperature?: number };
}

export interface ToolCall {
  name: string;
  status: 'started' | 'completed' | 'error';
  /** Measured by the page between `started` and its end (approximate). */
  ms: number | null;
  startedAt: number;
}

export type EntryState = 'queued' | 'running' | 'done' | 'error';

/** One answer card. */
export interface Entry {
  key: string;
  column: Column;
  state: EntryState;
  text: string;
  tools: ToolCall[];
  /** Write tools the agent asked for: never run (D91 (2)). */
  writes: string[];
  done: PlaygroundDone | null;
}

export interface Run {
  id: string;
  input: string;
  entries: Entry[];
}

/** A stream event applied to its card. `now` is the page clock, to time the tools. */
export function applyEvent(entry: Entry, event: PlaygroundEvent, now: number): Entry {
  switch (event.type) {
    case 'delta':
      return { ...entry, text: entry.text + event.text };
    case 'tool': {
      if (event.status === 'started') {
        const call: ToolCall = { name: event.name, status: 'started', ms: null, startedAt: now };
        return { ...entry, tools: [...entry.tools, call] };
      }
      // The end closes the oldest call of that tool still open.
      const index = entry.tools.findIndex(
        (call) => call.name === event.name && call.status === 'started',
      );
      if (index === -1) return entry;
      const tools = entry.tools.map((call, i) =>
        i === index
          ? { ...call, status: event.status, ms: Math.max(0, now - call.startedAt) }
          : call,
      );
      return { ...entry, tools };
    }
    case 'simulated_write': {
      // The call was announced with `tool` started under the same name and never answers: it
      // is shown once, as the write it would have asked for.
      const open = entry.tools.findIndex(
        (call) => call.name === event.tool && call.status === 'started',
      );
      const tools = open === -1 ? entry.tools : entry.tools.filter((_, i) => i !== open);
      const writes = entry.writes.includes(event.tool)
        ? entry.writes
        : [...entry.writes, event.tool];
      return { ...entry, tools, writes };
    }
    case 'done':
      return { ...entry, state: 'done', done: event };
    case 'error':
      return { ...entry, state: 'error' };
    case 'status':
      return entry;
  }
}

// --- Blocks --------------------------------------------------------------------------------------

/**
 * What stops every test until it is solved, from an answer of the server, with the texts of the
 * design (round 23 draws every code).
 */
export type Block =
  | { kind: 'budgetUser' | 'budgetAgent' | 'notTestable' | 'skill' | 'skills' | 'retired' }
  | { kind: 'model'; reason: 'off' | 'noTools' }
  | { kind: 'rate'; until: number }
  | { kind: 'unavailable' };

/** Seconds of a 429 when the server sent none usable. */
const RATE_FALLBACK_S = 60;

export function blockOfError(error: unknown, now: number): Block | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'budget_exceeded':
      return { kind: 'budgetUser' };
    case 'rate_limited':
    case 'playground_busy':
      return { kind: 'rate', until: now + (error.retryAfter ?? RATE_FALLBACK_S) * 1000 };
    case 'playground_unavailable':
      return { kind: 'unavailable' };
    case 'model_unavailable':
    case 'model_required':
      return { kind: 'model', reason: 'off' };
    case 'model_without_tools':
      return { kind: 'model', reason: 'noTools' };
    case 'version_not_testable':
      return { kind: 'notTestable' };
    case 'skill_unavailable':
      return { kind: 'skill' };
    case 'skills_unavailable':
      return { kind: 'skills' };
    case 'agent_retired':
      return { kind: 'retired' };
  }
  if (error.status === 429) {
    return { kind: 'rate', until: now + (error.retryAfter ?? RATE_FALLBACK_S) * 1000 };
  }
  return error.status === 402 ? { kind: 'budgetUser' } : null;
}

/** An `error` event of the stream that blocks the next tests too. */
export function blockOfEvent(event: Extract<PlaygroundEvent, { type: 'error' }>): Block | null {
  if (event.code !== 'budget_exceeded') return null;
  return { kind: event.scope === 'agent' ? 'budgetAgent' : 'budgetUser' };
}

// --- Formats (design: comma decimals) ------------------------------------------------------------

export const formatSeconds = (ms: number) => (ms / 1000).toFixed(1).replace('.', ',');
export const formatCost = (usd: string) => Number(usd).toFixed(4).replace('.', ',');
export const formatCount = (value: number) =>
  value.toLocaleString('es-ES', { useGrouping: 'always' });
