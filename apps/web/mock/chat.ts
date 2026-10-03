/** Chat of the mock: conversations in memory and the SSE stream of POST /api/chat. */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { agents, versionOf } from './agents.ts';
import { approvalsOfConversation, requestFromChat } from './approvals.ts';
import { recordAudit } from './audit.ts';
import { newId, readBody, sendError, sendJson, type ApiHandler } from './http.ts';

interface StoredMessage {
  message_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  tools: { name: string; status: string }[];
  /** Ids of the approval requests the answer's write tool calls created (D27). */
  approvals?: string[];
}

interface StoredConversation {
  conversation_id: string;
  /** Fixed by the first turn (`POST /chat` with `agent_id`). */
  agent_id: string;
  title: string;
  updated_at: string;
  messages: StoredMessage[];
}

const conversations = new Map<string, StoredConversation>();
/** Agent of a chat that names none, and of the seeded conversations. */
const RELEASE_AGENT = 'finops';
const AGENT_ID = /^(?:[a-z2-7]{16}|[a-z][a-z0-9]{1,15})$/;

const CANNED_ANSWER = `Este es el resumen del **gasto de septiembre de 2026** (del 1 al 28, todas las cuentas de la organización):

| Servicio | Costo (USD) | Variación vs. agosto |
|---|---:|---:|
| Amazon EC2 | 12.430,55 | +8,2 % |
| Amazon RDS | 4.210,10 | -1,4 % |
| Amazon S3 | 1.874,32 | +0,6 % |
| **Total** | **18.514,97** | **+5,1 %** |

**Principal driver:** EC2 en la cuenta \`prod-payments\` (instancias \`m7i.2xlarge\` nuevas desde el día 12).

Recomendaciones:
1. Revisar el rightsizing de las instancias \`m7i.2xlarge\` (ahorro estimado: USD 1.100/mes).
2. Evaluar un Compute Savings Plan de 1 año.

---
*Pruebas de renderizado seguro (contenido no confiable del modelo):*

- Enlace externo con confirmación: [documentación de Cost Explorer](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html)
- Enlace \`javascript:\` neutralizado: [haz clic](javascript:alert(document.domain))
- Imagen remota bloqueada: ![pixel](https://attacker.example/p.png?d=secret)
- HTML crudo descartado: <script>alert(1)</script><img src=x onerror=alert(1)><b>negrita html</b>
`;

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Dev-only history spread over several days, so the grouped conversation list (hoy, ayer, esta
 * semana, anteriores) can be reviewed without waiting days. Titles include HTML to check they
 * render as text.
 */
function seedConversations(): void {
  const HOUR_MS = 3_600_000;
  const savingsPlans = [...agents.values()].find(
    (agent) =>
      agent.status === 'published' &&
      versionOf(agent, agent.published_version)?.definition.name === 'Savings Plans',
  );
  const seeds: [title: string, hoursAgo: number, agentId: string][] = [
    ['Gasto de EC2 del mes', 1, RELEASE_AGENT],
    ['Pronóstico de fin de mes', 26, RELEASE_AGENT],
    ['Anomalías <b>de la semana</b>', 4 * 24, RELEASE_AGENT],
    ['Savings Plans de agosto', 20 * 24, savingsPlans?.agent_id ?? RELEASE_AGENT],
  ];
  for (const [title, hoursAgo, agentId] of seeds) {
    const updatedAt = new Date(Date.now() - hoursAgo * HOUR_MS).toISOString();
    const conversationId = newId();
    conversations.set(conversationId, {
      conversation_id: conversationId,
      agent_id: agentId,
      title,
      updated_at: updatedAt,
      messages: [
        {
          message_id: newId(),
          role: 'user',
          content: `${title}?`,
          created_at: updatedAt,
          tools: [],
        },
        {
          message_id: newId(),
          role: 'assistant',
          content: CANNED_ANSWER,
          created_at: updatedAt,
          tools: [
            { name: 'get_cost_and_usage', status: 'started' },
            { name: 'get_cost_and_usage', status: 'completed' },
            { name: 'get_cost_forecast', status: 'started' },
            { name: 'get_cost_forecast', status: 'completed' },
          ],
        },
      ],
    });
  }
}
seedConversations();

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendError(res, 422, 'invalid_request', 'Invalid JSON body');
    return;
  }
  const record: Record<string, unknown> =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const allowedKeys = ['agent_id', 'conversation_id', 'message', 'model'];
  const { conversation_id: conversationId, message, agent_id: agentId, model } = record;
  if (
    Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
    typeof message !== 'string' ||
    message.length < 1 ||
    message.length > 4000 ||
    (conversationId != null && typeof conversationId !== 'string') ||
    (agentId != null && (typeof agentId !== 'string' || !AGENT_ID.test(agentId))) ||
    (model != null && typeof model !== 'string')
  ) {
    sendError(res, 422, 'invalid_request', 'Invalid chat request');
    return;
  }
  if (/presupuesto agotado/i.test(message)) {
    sendError(res, 402, 'budget_exceeded', 'Budget exceeded');
    return;
  }

  let conversation =
    typeof conversationId === 'string' ? conversations.get(conversationId) : undefined;
  if (typeof conversationId === 'string' && !conversation) {
    sendError(res, 404, 'not_found', 'Conversation not found');
    return;
  }
  // A conversation keeps the agent of its first turn; the agent must be published and the
  // model one of the version's allowed models (same answers as the API).
  const chatAgent =
    conversation?.agent_id ?? (typeof agentId === 'string' ? agentId : RELEASE_AGENT);
  if (typeof agentId === 'string' && agentId !== chatAgent) {
    sendError(res, 409, 'agent_mismatch', 'This conversation belongs to another agent');
    return;
  }
  const agent = agents.get(chatAgent);
  const version = agent ? versionOf(agent, agent.published_version) : null;
  if (!agent || !version || agent.status === 'draft') {
    sendError(res, 403, 'forbidden', 'not allowed');
    return;
  }
  if (agent.status === 'retired') {
    sendError(res, 409, 'agent_retired', 'This agent was retired');
    return;
  }
  const chatModel = typeof model === 'string' ? model : (version.definition.model ?? '');
  if (!version.definition.allowed_models.includes(chatModel)) {
    sendError(res, 422, 'model_not_allowed', 'The agent does not allow this model');
    return;
  }
  if (!conversation) {
    conversation = {
      conversation_id: newId(),
      agent_id: chatAgent,
      title: message.slice(0, 60),
      updated_at: '',
      messages: [],
    };
    conversations.set(conversation.conversation_id, conversation);
  }
  const now = new Date().toISOString();
  conversation.updated_at = now;
  conversation.messages.push({
    message_id: newId(),
    role: 'user',
    content: message,
    created_at: now,
    tools: [],
  });
  // Same events as the API: the turn's `UseAgent` decision, `agent.invoke`, then
  // `agent.completed` with the settled cost and the turn's authorization.
  const turn = {
    agent: chatAgent,
    version: version.number,
    model: chatModel,
    conversation_id: conversation.conversation_id,
    turn: newId(),
  };
  recordAudit('policy.decision', {
    action: 'UseAgent',
    resource: `Mango::Agent::${chatAgent}`,
    allowed: true,
    read_only: false,
    conversation_id: turn.conversation_id,
    turn: turn.turn,
  });
  recordAudit('agent.invoke', turn);

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  const stream = { closed: false };
  req.on('close', () => {
    stream.closed = true;
  });
  const send = (event: string, data: unknown) => {
    if (!stream.closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('conversation', { conversation_id: conversation.conversation_id });
  // Live progress like the API: `status` on every phase change, never text of the model.
  send('status', { phase: 'thinking' });
  await sleep(300);
  if (/error/i.test(message)) {
    send('error', { code: 'upstream_error', message: 'Simulated upstream failure' });
    res.end();
    return;
  }
  // "crea un presupuesto de 300 para team-a": the agent calls the write tool, the Gateway
  // refuses it and the API asks a person to confirm (D27).
  const budget = /presupuesto de (\d{1,9})(?: para ([a-z0-9-]{1,40}))?/i.exec(message);
  if (budget) {
    send('tool', { name: 'create_budget', status: 'started' });
    await sleep(600);
    send('tool', { name: 'create_budget', status: 'error' });
    const request = requestFromChat(
      conversation.conversation_id,
      budget[2] ?? 'nuevo',
      Number(budget[1]),
    );
    send('approval', request);
    const reply =
      request.tier === 'self'
        ? 'Esta acción modifica recursos. Según la política, basta con **tu confirmación** antes de ejecutarla.'
        : 'Puedo hacerlo, pero la política exige **aprobación de otras personas**. La dejé en cola; cuando la aprueben podrás ejecutarla desde aquí.';
    send('delta', { text: reply });
    const replyId = newId();
    conversation.messages.push({
      message_id: replyId,
      role: 'assistant',
      content: reply,
      created_at: new Date().toISOString(),
      tools: [
        { name: 'create_budget', status: 'started' },
        { name: 'create_budget', status: 'error' },
      ],
      approvals: [request.approval_id],
    });
    send('done', {
      message_id: replyId,
      stop_reason: 'end_turn',
      usage: { input_tokens: 420, output_tokens: 60 },
      cost_usd: '0.0031',
    });
    res.end();
    return;
  }
  // To review the progress states: "en paralelo" runs two tools at once and one fails;
  // "guardrail" cuts the answer halfway, like the API's `guardrail_intervened`.
  const parallel = /paralelo/i.test(message);
  const cut = /guardrail/i.test(message);
  send('tool', { name: 'get_cost_and_usage', status: 'started' });
  send('status', { phase: 'tool', tool: 'get_cost_and_usage' });
  if (parallel) send('tool', { name: 'get_rightsizing_recommendations', status: 'started' });
  res.write(': ping\n\n');
  await sleep(1200);
  if (parallel) send('tool', { name: 'get_rightsizing_recommendations', status: 'error' });
  send('tool', { name: 'get_cost_and_usage', status: 'completed' });
  send('status', { phase: 'tool_result' });
  send('tool', { name: 'get_cost_forecast', status: 'started' });
  send('status', { phase: 'tool', tool: 'get_cost_forecast' });
  await sleep(700);
  send('tool', { name: 'get_cost_forecast', status: 'completed' });
  send('status', { phase: 'tool_result' });
  await sleep(500);
  send('status', { phase: 'writing' });

  let answer = '';
  const text = cut
    ? CANNED_ANSWER.slice(0, Math.round(CANNED_ANSWER.length * 0.45))
    : CANNED_ANSWER;
  for (const piece of chunkText(text, 24)) {
    if (stream.closed) break;
    answer += piece;
    // Split a chunk across two writes to exercise the client's incremental parser.
    const frame = `event: delta\r\ndata: ${JSON.stringify({ text: piece })}\r\n\r\n`;
    res.write(frame.slice(0, 10));
    res.write(frame.slice(10));
    await sleep(40);
  }
  const messageId = newId();
  conversation.messages.push({
    message_id: messageId,
    role: 'assistant',
    content: answer,
    created_at: new Date().toISOString(),
    tools: [
      { name: 'get_cost_and_usage', status: 'completed' },
      ...(parallel ? [{ name: 'get_rightsizing_recommendations', status: 'error' }] : []),
      { name: 'get_cost_forecast', status: 'completed' },
    ],
  });
  send('done', {
    message_id: messageId,
    stop_reason: cut ? 'guardrail_intervened' : 'end_turn',
    usage: { input_tokens: 1234, output_tokens: 321 },
    cost_usd: '0.0123',
  });
  recordAudit('agent.completed', {
    ...turn,
    stop_reason: 'end_turn',
    tools: ['get_cost_and_usage', 'get_cost_forecast'],
    input_tokens: 1234,
    output_tokens: 321,
    cost_usd: '0.0123',
    authz: { action: 'UseAgent', allowed: true },
  });
  res.end();
}

export const handleChatApi: ApiHandler = async (req, res, path) => {
  if (path === '/conversations' && req.method === 'GET') {
    const items = [...conversations.values()]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(({ conversation_id, title, updated_at, agent_id }) => ({
        conversation_id,
        title,
        updated_at,
        agent_id,
      }));
    sendJson(res, 200, { items });
    return true;
  }
  const match = /^\/conversations\/([A-Za-z0-9_-]+)$/.exec(path);
  if (match && req.method === 'GET') {
    const conversation = conversations.get(match[1] ?? '');
    if (!conversation) {
      sendError(res, 404, 'not_found', 'Conversation not found');
      return true;
    }
    const { conversation_id, title, agent_id, messages } = conversation;
    sendJson(res, 200, {
      conversation_id,
      title,
      agent_id,
      messages,
      approvals: approvalsOfConversation(conversation_id),
    });
    return true;
  }
  if (path === '/chat' && req.method === 'POST') {
    await handleChat(req, res);
    return true;
  }
  return false;
};
