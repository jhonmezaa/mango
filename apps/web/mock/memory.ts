/**
 * Mock routes of the agents' memory (D122, design round 41 `memory.jsx`): GET /memory, DELETE
 * /memory and DELETE /memory/{record_id}, in the generated contract and with the rules of
 * `mango_api.memory` the screen depends on: only the caller's records, the 300 most recent with
 * their total, the same 404 for «not yours» and «does not exist», and an id checked by pattern
 * (422). The mock installation has memory on, so the screen has something to show; the states
 * «apagada», 503 and 429 are seen with `page.route` in the e2e tests. A record with HTML checks
 * that the text renders as text.
 */
import { MOCK_USER } from './cognito.ts';
import { sendError, sendJson, type ApiHandler } from './http.ts';

type Kind = 'preferences' | 'facts' | 'summaries';

interface MockRecord {
  record_id: string;
  owner: string;
  agent_id: string;
  kind: Kind;
  text: string;
  truncated: boolean;
  created_at: string;
}

const MAX_RECORDS = 300;
const RECORD_ID = /^mem-[a-zA-Z0-9_-]{36,46}$/;
const DAY_MS = 86_400_000;
/** An agent that no longer answers the mock user: the screen shows its id. */
const GONE_AGENT = 'q5zr7mx2k4nd6wbt';

const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
const id = (n: number) => `mem-${String(n).padStart(36, '0')}`;

const records = new Map<string, MockRecord>();

function seed(): void {
  const rows: [string, Kind, string, number, boolean?][] = [
    [
      'finops',
      'preferences',
      'Prefiere las cifras en USD sin decimales y las tablas ordenadas de mayor a menor costo.',
      1,
    ],
    [
      'finops',
      'facts',
      'Es responsable del costo de las cuentas 111122223333 y 444455556666 (plataforma de datos).',
      2,
    ],
    [
      'finops',
      'summaries',
      'Revisó el aumento de EC2 de agosto a octubre de 2026. Quedó pendiente pedir al equipo de plataforma que limpie los snapshots EBS huérfanos de us-east-1 y que evalúe consolidar los NAT Gateways. Pidió volver a revisarlo a fin de mes con el pronóstico de los próximos tres meses y comparar contra el presupuesto del trimestre, que ya va al 80 %. También preguntó por Savings Plans de cómputo a un año para la carga estable de',
      3,
      true,
    ],
    [
      'finops',
      'preferences',
      'Quiere que las recomendaciones lleven el ahorro mensual estimado y quién es el equipo responsable.',
      9,
    ],
    [
      GONE_AGENT,
      'facts',
      'Las cohortes se cuentan por mes de activación, no por mes de registro.',
      5,
    ],
    [GONE_AGENT, 'summaries', 'Pidió las tablas en <b>negrita</b>: se guardó como texto.', 12],
  ];
  rows.forEach(([agent, kind, text, days, truncated = false], index) => {
    records.set(id(index + 1), {
      record_id: id(index + 1),
      owner: MOCK_USER,
      agent_id: agent,
      kind,
      text,
      truncated,
      created_at: ago(days),
    });
  });
  // Someone else's record: never listed, and deleting it answers 404.
  records.set(id(99), {
    record_id: id(99),
    owner: 'otra.persona@example.com',
    agent_id: 'finops',
    kind: 'facts',
    text: 'De otra persona.',
    truncated: false,
    created_at: ago(1),
  });
}
seed();

/** The installation's memory (`AGENT_MEMORY_ENABLED`): on in the mock. */
export function memoryEnabled(): boolean {
  return true;
}

const mine = () =>
  [...records.values()]
    .filter((record) => record.owner === MOCK_USER)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

function route(req: Parameters<ApiHandler>[0], res: Parameters<ApiHandler>[1], path: string) {
  if (path !== '/memory' && !path.startsWith('/memory/')) return false;
  if (path === '/memory' && req.method === 'GET') {
    const all = mine();
    sendJson(res, 200, {
      enabled: memoryEnabled(),
      records: all
        .slice(0, MAX_RECORDS)
        .map(({ record_id, agent_id, kind, text, truncated, created_at }) => ({
          record_id,
          agent_id,
          kind,
          text,
          truncated,
          created_at,
        })),
      complete: all.length <= MAX_RECORDS,
      total: all.length,
    });
    return true;
  }
  if (path === '/memory' && req.method === 'DELETE') {
    const all = mine();
    for (const record of all) records.delete(record.record_id);
    // Events are what the conversations wrote: the mock counts a few per record.
    sendJson(res, 200, { records: all.length, events: all.length * 6 + 3 });
    return true;
  }
  const recordId = decodeURIComponent(path.slice('/memory/'.length));
  if (req.method === 'DELETE') {
    if (!RECORD_ID.test(recordId)) {
      sendError(res, 422, 'validation_failed', 'invalid record id');
      return true;
    }
    const record = records.get(recordId);
    if (!record || record.owner !== MOCK_USER) {
      sendError(res, 404, 'not_found', 'memory not found');
      return true;
    }
    records.delete(recordId);
    res.statusCode = 204;
    res.end();
    return true;
  }
  sendError(res, 405, 'method_not_allowed', 'Method not allowed');
  return true;
}

export const handleMemory: ApiHandler = (req, res, path) => Promise.resolve(route(req, res, path));
