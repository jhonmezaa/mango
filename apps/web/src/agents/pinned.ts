import { readPreference, writePreference } from '../preferences/storage';
import { parseAgentId } from './agents';

// Pinned agents of the sidebar (design app.jsx `mango-pinned-agents`): a UI preference of this
// browser, never used for access. Storage content is untrusted: only well-formed agent ids are
// kept, and an id only shows up if the API also lists that agent for the user.

const KEY = 'mango-pinned-agents';
const MAX_PINNED = 20;
/** Without a stored preference the agent of the release is pinned (as before agents were data). */
const DEFAULT_PINNED: readonly string[] = ['finops'];

function clean(values: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const value of values) {
    const id = parseAgentId(value);
    if (id !== null && !ids.includes(id)) ids.push(id);
    if (ids.length === MAX_PINNED) break;
  }
  return ids;
}

export function readPinnedAgents(): string[] {
  const raw = readPreference(KEY);
  if (raw === null) return [...DEFAULT_PINNED];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? clean(parsed) : [...DEFAULT_PINNED];
  } catch {
    return [...DEFAULT_PINNED];
  }
}

/** The list after pinning or unpinning `agentId`; also stored. */
export function togglePinnedAgent(pinned: readonly string[], agentId: string): string[] {
  const next = pinned.includes(agentId)
    ? pinned.filter((id) => id !== agentId)
    : clean([...pinned, agentId]);
  writePreference(KEY, JSON.stringify(next));
  return next;
}
