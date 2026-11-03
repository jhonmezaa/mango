/**
 * Mock route of Buscar conversaciones (D103): POST /search/conversations, with the rules of
 * `mango_api.conversation_search` over the conversations of the chat mock (plain text, every term
 * in the same text, snippets of 60 characters before and 140 after, the design's score). The mock
 * reads everything: `capped` is false unless `?q=` holds `mock-capped`, to see the line of a
 * search that stopped at its cap. The response follows the generated contract.
 */
import { conversationsOfMine } from './chat.ts';
import { readBody, sendError, sendJson, type ApiHandler } from './http.ts';

type Kind = 'title' | 'user' | 'agent' | 'tool';
type Hit = { kind: Kind; message_id: string | null } & ReturnType<typeof snippet>;
const KINDS = new Set(['all', 'title', 'user', 'agent', 'tool']);
const WHENS = new Set(['all', 'today', 'yesterday']);
const SORTS = new Set(['relevance', 'recent']);
const AGENT_ID = /^(?:[a-z2-7]{16}|[a-z][a-z0-9]{1,15})$/;
const MAX_RESULTS = 100;
const MAX_HITS = 20;

const plain = (text: string) =>
  text
    .replace(/\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?/g, ' ')
    .replace(/[*`|#_>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function snippet(text: string, terms: string[]) {
  const low = text.toLowerCase();
  const first = Math.min(...terms.map((t) => low.indexOf(t)).filter((i) => i >= 0));
  const start = Math.max(0, first - 60);
  const end = Math.min(text.length, first + 140);
  const window = text.slice(start, end);
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = window
    .split(new RegExp(`(${escaped.join('|')})`, 'gi'))
    .map((part, i) => ({ text: part, hit: i % 2 === 1 }))
    .filter((part) => part.text);
  return { pre: start > 0, post: end < text.length, parts };
}

function startOf(when: string, offsetMinutes: number, now: number): number | null {
  if (when === 'all') return null;
  const offset = offsetMinutes * 60_000;
  const local = new Date(now + offset);
  local.setUTCHours(0, 0, 0, 0);
  const day = when === 'yesterday' ? 86_400_000 : 0;
  return local.getTime() - day - offset;
}

const FIELDS = new Set(['q', 'agent', 'kind', 'when', 'sort', 'utc_offset_minutes']);

async function bodyOf(req: Parameters<ApiHandler>[0]): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = JSON.parse((await readBody(req)) || '{}');
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    return Object.keys(record).every((key) => FIELDS.has(key)) ? record : null;
  } catch {
    return null;
  }
}

const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);

export const handleSearch: ApiHandler = async (req, res, path) => {
  if (path !== '/search/conversations' || req.method !== 'POST') return false;
  const body = await bodyOf(req);
  const q = text(body?.q, '');
  const agent = typeof body?.agent === 'string' ? body.agent : null;
  const kind = text(body?.kind, 'all');
  const when = text(body?.when, 'all');
  const sort = text(body?.sort, 'relevance');
  const offset = body?.utc_offset_minutes ?? 0;
  if (
    !body ||
    !q ||
    q.length > 200 ||
    (agent !== null && !AGENT_ID.test(agent)) ||
    !KINDS.has(kind) ||
    !WHENS.has(when) ||
    !SORTS.has(sort) ||
    typeof offset !== 'number' ||
    !Number.isInteger(offset) ||
    Math.abs(offset) > 840
  ) {
    sendError(res, 422, 'invalid_request', 'invalid fields');
    return true;
  }
  const terms = [
    ...new Set(
      q
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 2),
    ),
  ].slice(0, 8);
  const since = startOf(when, offset, Date.now());
  const read = conversationsOfMine();
  const found = read.flatMap((conversation, order) => {
    if (agent !== null && conversation.agent_id !== agent) return [];
    if (since !== null && Date.parse(conversation.updated_at) < since) return [];
    if (!terms.length) return [];
    const hits: Hit[] = [];
    const test = (k: Kind, id: string | null, raw: string) => {
      if ((kind !== 'all' && kind !== k) || !raw) return;
      const text = k === 'tool' ? raw : plain(raw);
      const low = text.toLowerCase();
      if (!terms.every((t) => low.includes(t))) return;
      hits.push({ kind: k, message_id: id, ...snippet(text, terms) });
    };
    test('title', null, conversation.title);
    for (const message of conversation.messages) {
      if (message.role === 'user') test('user', message.message_id, message.content);
      else {
        test('agent', message.message_id, message.content);
        const names = [...new Set(message.tools.map((tool) => tool.name))];
        test('tool', message.message_id, names.join(' '));
      }
    }
    if (!hits.length) return [];
    const score = hits.length + (hits[0]?.kind === 'title' ? 5 : 0);
    return [{ conversation, hits, score, order }];
  });
  if (sort === 'relevance') found.sort((a, b) => b.score - a.score || a.order - b.order);
  sendJson(res, 200, {
    results: found.slice(0, MAX_RESULTS).map(({ conversation, hits }) => ({
      conversation_id: conversation.conversation_id,
      title: conversation.title,
      agent_id: conversation.agent_id,
      updated_at: conversation.updated_at,
      hits: hits.slice(0, MAX_HITS),
    })),
    conversations_read: read.length,
    capped: q.includes('mock-capped'),
    truncated: found.length > MAX_RESULTS,
  });
  return true;
};
