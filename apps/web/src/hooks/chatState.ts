import { parseCells } from '../api/codeSchemas';
import type { ChatApproval, Message, ToolCall, ToolStatus } from '../api/schemas';
import type { MessageAttachment } from '../components/chat/attachments';
import type { CodeFile } from '../api/codeSchemas';
import type { TextdocCard } from '../components/chat/canvas/canvasApi';
import { parseExportFiles, parseTextdocCards } from '../components/chat/canvas/textdocCards';
import { CODE_RECIPIENT, type CodeBlockData } from './codeBlock';
import type { TurnView } from './turnView';

/** An MCP App of an answer (D125): what the message knows of it. */
export interface MessageApp {
  readonly appId: string;
  readonly registrationId: string;
  readonly tool: string;
}

function appOf(app: { app_id: string; registration_id: string; tool: string }): MessageApp {
  return { appId: app.app_id, registrationId: app.registration_id, tool: app.tool };
}

/**
 * A change of a turn read in `v1` (D120), as the reducer folds it: what `eventsOfChange` finds
 * between two views. The text and the end of the turn come from the view itself.
 */
export type TurnEvent =
  | { type: 'tool'; name: string; status: ToolStatus }
  | { type: 'status'; phase: string; tool?: string | undefined }
  | { type: 'approval'; approval: ChatApproval }
  | {
      type: 'knowledge';
      knowledge_bases: string[];
      count: number;
      sources: { knowledge_base: string; document: string; page?: number | undefined }[];
    }
  | { type: 'remote_connection_required'; registration_id: string };

/**
 * `interrupted`: Mango lost the turn halfway (design round 40): the text it wrote stays, with
 * its notice and without «Reintentar». `away`: the session ended while the turn was read; the
 * answer goes on in Mango.
 */
export type MessageStatus = 'streaming' | 'done' | 'error' | 'stopped' | 'interrupted' | 'away';

/**
 * The connection of a turn being read (design round 40 `ConnLine`): reconnecting (attempt n of
 * 12), reconnected for 2.5 s, or given up until «Volver a conectar».
 */
export type ConnectionView =
  { kind: 'reconnecting'; attempt: number } | { kind: 'resumed' } | { kind: 'failed' };

/**
 * `interrupted`: the turn ended (stopped, failed or finished) while the tool was still `started`,
 * so no completion will ever arrive. UI-only; the API never sends it.
 */
export type DisplayToolStatus = ToolStatus | 'interrupted';

/**
 * A tool call as shown in the UI. The SSE `tool` event only carries name and status; the timing is
 * measured on the client between `started` and `completed`/`error` (absent for loaded history).
 */
export interface DisplayToolCall extends Omit<ToolCall, 'status'> {
  status: DisplayToolStatus;
  startedAt?: number;
  durationMs?: number;
}

/** Closes tool calls left `started` once their turn is over, so no spinner outlives the turn. */
export function settleTools(tools: DisplayToolCall[]): DisplayToolCall[] {
  return tools.some((tool) => tool.status === 'started')
    ? tools.map((tool) => (tool.status === 'started' ? { ...tool, status: 'interrupted' } : tool))
    : tools;
}

/**
 * What the agent is doing while the turn streams (SSE `status`); structured, never model text.
 * `code`: a cell of the sandbox runs (design round 40 «Ejecutando código…»).
 */
export type ProgressPhase = 'thinking' | 'tool' | 'tool_result' | 'writing' | 'code';

export interface TurnProgress {
  phase: ProgressPhase;
  /** Display name of the tool in flight (phase `tool`). */
  tool?: string;
}

const PROGRESS_PHASES: ReadonlySet<string> = new Set<ProgressPhase>([
  'thinking',
  'tool',
  'tool_result',
  'writing',
  'code',
]);

function isProgressPhase(phase: string): phase is ProgressPhase {
  return PROGRESS_PHASES.has(phase);
}

/** One step of a turn in flight (design chat.jsx `streamSteps`): what the agent did, in order. */
export interface TurnStep {
  id: number;
  kind: ProgressPhase;
  /** Name of the tool, as the stream gave it (untrusted: rendered as text only). */
  tool?: string;
  status: 'running' | 'ok' | 'failed';
}

/** Stop reason of a turn whose answer the guardrail cut (the API's `GUARDRAIL_STOP`). */
const GUARDRAIL_STOP = 'guardrail_intervened';
/** Stop reason of a model call that reached its output cap (the API's `CAP_STOP`, D74). */
export const CAP_STOP = 'max_tokens';

/**
 * How an answer cut at its token cap ended (design round 34, «Respuesta incompleta»): while it
 * wrote (`tokens`) or while it prepared a tool call that was never made (`tool`). `tool` names
 * the tool only as the API's progress named it (a tool of the published version), never the
 * name the model wrote.
 */
export type Truncation = { kind: 'tokens' } | { kind: 'tool'; tool: string | null };

function truncationOf(message: DisplayMessage): Truncation {
  // The cap cut the message that called a tool: its call started and no answer came.
  if (!message.tools.some((tool) => tool.status === 'started')) return { kind: 'tokens' };
  const progress = message.progress;
  return { kind: 'tool', tool: progress?.phase === 'tool' && progress.tool ? progress.tool : null };
}

function closeSteps(steps: readonly TurnStep[], keep: (step: TurnStep) => boolean): TurnStep[] {
  return steps.map((step) =>
    step.status === 'running' && !keep(step) ? { ...step, status: 'ok' } : step,
  );
}

// A cell is a tool call with a step of its own («Ejecutó código», design round 40).
const isToolStep = (step: TurnStep) => step.kind === 'tool' || step.kind === 'code';

/** A phase of the turn began: what was running (except tools, which report on their own) ends. */
function stepsOnPhase(steps: readonly TurnStep[], phase: ProgressPhase): TurnStep[] {
  const next = closeSteps(steps, (step) => isToolStep(step) || step.kind === phase);
  if (
    phase === 'tool' ||
    phase === 'code' ||
    next.some((step) => step.kind === phase && step.status === 'running')
  ) {
    return next;
  }
  return [...next, { id: next.length, kind: phase, status: 'running' }];
}

/** A tool started or ended: its own step, matched by name like the tool list. */
function stepsOnTool(steps: readonly TurnStep[], tool: ToolCall): TurnStep[] {
  if (tool.status === 'started') {
    const next = closeSteps(steps, isToolStep);
    if (tool.name === CODE_RECIPIENT) {
      return [...next, { id: next.length, kind: 'code', tool: tool.name, status: 'running' }];
    }
    return [...next, { id: next.length, kind: 'tool', tool: tool.name, status: 'running' }];
  }
  const index = steps.findLastIndex(
    (step) => isToolStep(step) && step.tool === tool.name && step.status === 'running',
  );
  if (index < 0) return [...steps];
  const status = tool.status === 'error' ? 'failed' : 'ok';
  return steps.map((step, i) => (i === index ? { ...step, status } : step));
}

/** A source of an answer (D88 (44)): plain text, never the text of the fragment. */
export interface Citation {
  knowledgeBase: string;
  document: string;
  page: number | null;
}

/** One knowledge search of a turn in flight (design `KbStep`): where, and how many fragments. */
export interface KnowledgeSearch {
  knowledgeBases: string[];
  count: number;
}

const MAX_CITATIONS = 24;

/** Adds the sources not cited yet, in order, as the API keeps them on the message. */
function addCitations(current: readonly Citation[], sources: readonly Citation[]): Citation[] {
  const key = (c: Citation) => `${c.knowledgeBase}\u0000${c.document}\u0000${String(c.page)}`;
  const seen = new Set(current.map(key));
  const out = [...current];
  for (const source of sources) {
    if (out.length >= MAX_CITATIONS) break;
    if (seen.has(key(source))) continue;
    seen.add(key(source));
    out.push(source);
  }
  return out;
}

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tools: DisplayToolCall[];
  /** Requests to confirm the write tool calls of this answer (D27), shown as cards after it. */
  approvals?: ChatApproval[];
  status: MessageStatus;
  /** Latest progress of a streaming turn; absent until the API sends one and in loaded history. */
  progress?: TurnProgress;
  /** Steps of a streaming turn, in order; dropped once the turn is over (design: live only). */
  steps?: TurnStep[];
  /** The guardrail cut the answer: what was written stays and a notice follows it. */
  guardrail?: boolean;
  /** The answer reached its token cap (live only, like `guardrail`): a notice follows it. */
  truncated?: Truncation;
  /** Knowledge searches of the turn while it runs and after (not stored: live only). */
  searches?: KnowledgeSearch[];
  /** Sources of the answer, from the searches of the turn or the stored message. */
  citations?: Citation[];
  /** Remote registrations that asked the person to connect (D98 (20)): one card each. */
  connectionRequired?: string[];
  /** Client clock (ms) when the first of them arrived; stored messages use `createdAt`. */
  connectionAt?: number;
  /** Remote registrations whose tools answered («Leyó {servicio}», link dialog A1). */
  remoteSources?: string[];
  /** MCP Apps of the answer (D125): drawn under its text, each one read by its id. */
  apps?: MessageApp[];
  /**
   * A question of a turn another tab is answering (design round 40 «Desde otra pestaña»): shown
   * when this tab's message was refused because of it.
   */
  fromOtherTab?: boolean;
  /** The files of a question (D116): what was sent, or what the history says of them. */
  attachments?: MessageAttachment[];
  /** ISO timestamp: `created_at` for loaded history, the client clock for messages sent now. */
  createdAt?: string;
  errorKey?: ErrorKey;
  /** While a turn is read and its connection is not live (live only). */
  connection?: ConnectionView;
  /** A 429 (design round 34 `RateWait`): when «Reintentar» may be used (client clock, ms). */
  retryAt?: number;
  usage?: { inputTokens: number; outputTokens: number; costUsd: string };
  /** The «Analizando» block of an answer that ran code (C4): live from `v1`, or stored. */
  code?: CodeBlockData;
  /** The cards of the Canvas documents this answer wrote (D124): live from `v1`, or stored. */
  textdocs?: TextdocCard[];
  /** The files a Canvas export added (D124 (3)): a message without text, only their cards. */
  files?: CodeFile[];
}

export interface ChatState {
  conversationId: string | null;
  messages: DisplayMessage[];
}

export type ErrorKey =
  | 'errors.generic'
  | 'errors.budget_exceeded'
  | 'errors.forbidden'
  | 'errors.invalid_message'
  | 'errors.upstream_error'
  | 'errors.agent_unavailable'
  | 'errors.agent_retired'
  | 'errors.agent_mismatch'
  | 'errors.model_not_allowed'
  | 'errors.model_unavailable'
  | 'errors.conversation_busy'
  | 'errors.network'
  | 'errors.streamInterrupted'
  | 'errors.rate_limited';

const ERROR_KEYS: Record<string, ErrorKey> = {
  budget_exceeded: 'errors.budget_exceeded',
  forbidden: 'errors.forbidden',
  invalid_message: 'errors.invalid_message',
  upstream_error: 'errors.upstream_error',
  agent_unavailable: 'errors.agent_unavailable',
  agent_retired: 'errors.agent_retired',
  agent_mismatch: 'errors.agent_mismatch',
  model_not_allowed: 'errors.model_not_allowed',
  model_unavailable: 'errors.model_unavailable',
  conversation_busy: 'errors.conversation_busy',
  // Lost before it wrote anything: said as the agent's failure, with «Reintentar».
  turn_interrupted: 'errors.upstream_error',
  rate_limited: 'errors.rate_limited',
};

/** Maps a backend error code to a localized message; the backend text is never shown raw. */
export function errorKeyForCode(code: string, status?: number): ErrorKey {
  const known = ERROR_KEYS[code];
  if (known) return known;
  if (status === 402) return 'errors.budget_exceeded';
  if (status === 403) return 'errors.forbidden';
  if (status === 422) return 'errors.invalid_message';
  if (status === 429) return 'errors.rate_limited';
  return 'errors.generic';
}

export type ChatAction =
  | { type: 'reset'; conversationId: string | null; messages: DisplayMessage[] }
  | {
      type: 'send';
      userId: string;
      assistantId: string;
      text: string;
      sentAt?: string;
      attachments?: MessageAttachment[];
    }
  /** The conversation of a turn just created (`POST /api/chat/turns`). */
  | { type: 'conversation'; conversationId: string }
  /** The `v1` documents of a turn changed (D120): `view` after, `previous` before. */
  | {
      type: 'turn';
      assistantId: string;
      previous: TurnView;
      view: TurnView;
      receivedAt?: number;
    }
  | { type: 'connection'; assistantId: string; connection: ConnectionView | null }
  /**
   * A turn in flight read again: its answer follows the conversation as it was loaded. With
   * `otherTab`, its question (the last message, when it is one) is marked as from another tab.
   */
  | { type: 'resume'; assistantId: string; otherTab?: boolean }
  /** Messages that never reached the conversation (the server refused the turn). */
  | { type: 'withdraw'; ids: readonly string[] }
  /** A request changed (confirmed, signed, run…): replace it wherever it is shown. */
  | { type: 'approval'; approval: ChatApproval }
  /** A message stored outside a turn (a Canvas export, D124 (3)), added at the end. */
  | { type: 'append'; message: DisplayMessage }
  | {
      type: 'finish';
      assistantId: string;
      status: Exclude<MessageStatus, 'streaming'>;
      errorKey?: ErrorKey;
      retryAt?: number;
    };

export const initialChatState: ChatState = { conversationId: null, messages: [] };

const NO_APPROVALS: ReadonlyMap<string, ChatApproval> = new Map();

export function fromApiMessage(
  message: Message,
  approvals: ReadonlyMap<string, ChatApproval> = NO_APPROVALS,
): DisplayMessage {
  return {
    id: message.message_id,
    role: message.role,
    content: message.content,
    // Stored history keeps `started` and `completed` as separate entries: fold them into one call.
    tools: settleTools(
      message.tools.reduce<DisplayToolCall[]>(
        (calls, tool) => upsertTool(calls, tool, undefined),
        [],
      ),
    ),
    approvals: (message.approvals ?? []).flatMap((id) => approvals.get(id) ?? []),
    citations: (message.citations ?? []).map((c) => ({
      knowledgeBase: c.knowledge_base,
      document: c.document,
      page: c.page ?? null,
    })),
    connectionRequired: message.connection_required ?? [],
    remoteSources: message.remote_sources ?? [],
    ...(message.apps?.length ? { apps: message.apps.map(appOf) } : {}),
    ...(message.code?.length ? { code: { cells: parseCells(message.code), pending: 0 } } : {}),
    ...(message.textdocs?.length ? { textdocs: parseTextdocCards(message.textdocs) } : {}),
    ...(message.files?.length ? { files: parseExportFiles(message.files) } : {}),
    // How a cut answer ended, after a reload (R3b): «Detener», or Mango lost the turn.
    status:
      message.stop_code === 'cancelled'
        ? 'stopped'
        : message.stop_code === 'turn_interrupted'
          ? 'interrupted'
          : 'done',
    createdAt: message.created_at,
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((file) => ({
            fileId: file.file_id,
            name: file.name,
            size: file.size_bytes,
            gone: file.gone,
          })),
        }
      : {}),
  };
}

function upsertTool(
  tools: DisplayToolCall[],
  tool: ToolCall,
  receivedAt: number | undefined,
): DisplayToolCall[] {
  // A tool can be called more than once per turn: update the latest unfinished call with that name.
  if (tool.status !== 'started') {
    for (let index = tools.length - 1; index >= 0; index--) {
      const current = tools[index];
      if (current?.name === tool.name && current.status === 'started') {
        const next: DisplayToolCall = { ...current, status: tool.status };
        if (current.startedAt !== undefined && receivedAt !== undefined) {
          next.durationMs = Math.max(0, receivedAt - current.startedAt);
        }
        return tools.map((item, i) => (i === index ? next : item));
      }
    }
  }
  const added: DisplayToolCall = { name: tool.name, status: tool.status };
  if (tool.status === 'started' && receivedAt !== undefined) added.startedAt = receivedAt;
  return [...tools, added];
}

function updateMessage(
  state: ChatState,
  id: string,
  update: (message: DisplayMessage) => DisplayMessage,
): ChatState {
  return {
    ...state,
    messages: state.messages.map((message) => (message.id === id ? update(message) : message)),
  };
}

/** The end of a turn Mango lost halfway (D121 (7), R3b): never an error of the agent. */
const LOST_CODE = 'turn_interrupted';
/** The end «Cancelar» writes (D121 (7)). */
const CANCELLED_CODE = 'cancelled';

/**
 * The changes from `previous` to `view` as the events of D57 the reducer already knows (the
 * steps, the timing of the tools and the knowledge searches are built from them). The text and
 * the end of the turn are set from the view itself.
 */
export function eventsOfChange(previous: TurnView, view: TurnView): TurnEvent[] {
  const events: TurnEvent[] = [];
  view.tools.forEach((tool, index) => {
    const before = previous.tools[index];
    if (!before) {
      events.push({ type: 'tool', name: tool.name, status: 'started' });
      if (tool.status !== 'started') events.push({ type: 'tool', ...tool });
    } else if (before.status !== tool.status) {
      events.push({ type: 'tool', ...tool });
    }
  });
  const phase = view.phase;
  if (phase && (previous.phase?.phase !== phase.phase || previous.phase.tool !== phase.tool)) {
    events.push({ type: 'status', ...phase });
  }
  for (const search of view.knowledge.slice(previous.knowledge.length)) {
    events.push({ type: 'knowledge', ...search });
  }
  const known = new Set(previous.approvals.map((item) => item.approval_id));
  for (const approval of view.approvals) {
    if (!known.has(approval.approval_id)) events.push({ type: 'approval', approval });
  }
  for (const registration of view.connectionRequired.slice(previous.connectionRequired.length)) {
    events.push({ type: 'remote_connection_required', registration_id: registration });
  }
  return events;
}

/** The end of a turn on its message, from the view's status (`in_progress`: nothing yet). */
function endOfTurn(message: DisplayMessage, view: TurnView): DisplayMessage {
  if (view.status === 'in_progress' || message.status !== 'streaming') return message;
  const settled = { ...message, tools: settleTools(message.tools), steps: [] };
  delete settled.connection;
  if (view.status === 'finished') {
    const result = view.result ?? {};
    const stop = result.stop_reason;
    // A call that ended without its cell was refused before it ran (no cell to wait for).
    if (settled.code?.pending) settled.code = { ...settled.code, pending: 0 };
    return {
      ...settled,
      status: 'done',
      ...(stop === GUARDRAIL_STOP ? { guardrail: true } : {}),
      ...(stop === CAP_STOP ? { truncated: truncationOf(message) } : {}),
      ...(result.remote_sources?.length ? { remoteSources: result.remote_sources } : {}),
      ...(result.apps?.length ? { apps: result.apps.map(appOf) } : {}),
      ...(result.usage
        ? {
            usage: {
              inputTokens: result.usage.input_tokens,
              outputTokens: result.usage.output_tokens,
              costUsd: result.cost_usd ?? '0',
            },
          }
        : {}),
    };
  }
  const code = view.error?.code ?? 'error';
  if (view.status === 'interrupted' || code === CANCELLED_CODE) {
    return { ...settled, status: 'stopped' };
  }
  // Mango lost the turn after it wrote something: charged in full
  // (D121 (7)); sending it again would not continue it, so there is no «Reintentar».
  if (code === LOST_CODE && view.text) return { ...settled, status: 'interrupted' };
  return {
    ...settled,
    status: 'error',
    errorKey: errorKeyForCode(code, view.error?.status),
  };
}

const hasCode = (block: CodeBlockData) => block.cells.length > 0 || block.pending > 0;

function sameBlock(a: CodeBlockData | undefined, b: CodeBlockData): boolean {
  return (
    a !== undefined &&
    a.pending === b.pending &&
    a.cells.length === b.cells.length &&
    a.cells.every((cell, i) => cell.run_id === b.cells[i]?.run_id)
  );
}

function sameCards(a: readonly TextdocCard[] | undefined, b: readonly TextdocCard[]): boolean {
  return (
    a !== undefined &&
    a.length === b.length &&
    a.every((card, i) => {
      const other = b.at(i);
      return other?.textdoc_id === card.textdoc_id && other.version === card.version;
    })
  );
}

/** One change of a turn on its answer: tools and their timing, steps, searches, requests. */
function applyEvent(
  state: ChatState,
  assistantId: string,
  event: TurnEvent,
  receivedAt?: number,
): ChatState {
  switch (event.type) {
    case 'tool':
      return updateMessage(state, assistantId, (message) => ({
        ...message,
        tools: upsertTool(message.tools, { name: event.name, status: event.status }, receivedAt),
        steps: stepsOnTool(message.steps ?? [], { name: event.name, status: event.status }),
      }));
    case 'approval':
      return updateMessage(state, assistantId, (message) => ({
        ...message,
        approvals: [...(message.approvals ?? []), event.approval],
      }));
    case 'remote_connection_required':
      return updateMessage(state, assistantId, (message) =>
        message.connectionRequired?.includes(event.registration_id)
          ? message
          : {
              ...message,
              connectionRequired: [...(message.connectionRequired ?? []), event.registration_id],
              // Wall clock: the card counts down the 10 minutes of the pending consent.
              connectionAt: message.connectionAt ?? Date.now(),
            },
      );
    case 'status': {
      // A phase this client does not know yet is shown as plain "thinking".
      const progress: TurnProgress = isProgressPhase(event.phase)
        ? { phase: event.phase, ...(event.tool ? { tool: event.tool } : {}) }
        : { phase: 'thinking' };
      return updateMessage(state, assistantId, (message) => ({
        ...message,
        progress,
        steps: stepsOnPhase(message.steps ?? [], progress.phase),
      }));
    }
    case 'knowledge':
      return updateMessage(state, assistantId, (message) => ({
        ...message,
        searches: [
          ...(message.searches ?? []),
          { knowledgeBases: event.knowledge_bases, count: event.count },
        ],
        citations: addCitations(
          message.citations ?? [],
          event.sources.map((source) => ({
            knowledgeBase: source.knowledge_base,
            document: source.document,
            page: source.page ?? null,
          })),
        ),
      }));
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'conversation':
      return { ...state, conversationId: action.conversationId };
    case 'turn': {
      const { assistantId, previous, view } = action;
      let next = state;
      for (const event of eventsOfChange(previous, view)) {
        next = applyEvent(next, assistantId, event, action.receivedAt);
      }
      return updateMessage(next, assistantId, (message) => {
        const withText =
          message.content === view.text ? message : { ...message, content: view.text };
        // A cell never changes once shown: the block keeps its object (and its memo) until a
        // cell is added or a call starts or ends.
        const changed = hasCode(view.code) && !sameBlock(message.code, view.code);
        const withCode = changed ? { ...withText, code: view.code } : withText;
        // The Canvas cards (D124): replaced only when one is added or a version changes.
        const cards =
          view.textdocs.length > 0 && !sameCards(message.textdocs, view.textdocs)
            ? { ...withCode, textdocs: view.textdocs }
            : withCode;
        return endOfTurn(cards, view);
      });
    }
    case 'connection':
      return updateMessage(state, action.assistantId, (message) => {
        if (message.status !== 'streaming') return message;
        if (action.connection === null) {
          const next = { ...message };
          delete next.connection;
          return next;
        }
        return { ...message, connection: action.connection };
      });
    case 'resume': {
      const last = state.messages.at(-1);
      const marked =
        action.otherTab && last?.role === 'user'
          ? [...state.messages.slice(0, -1), { ...last, fromOtherTab: true }]
          : state.messages;
      return {
        ...state,
        messages: [
          ...marked,
          {
            id: action.assistantId,
            role: 'assistant',
            content: '',
            tools: [],
            status: 'streaming',
          },
        ],
      };
    }
    case 'withdraw': {
      const ids = new Set(action.ids);
      return { ...state, messages: state.messages.filter((message) => !ids.has(message.id)) };
    }
    case 'reset':
      return { conversationId: action.conversationId, messages: action.messages };
    case 'append':
      return { ...state, messages: [...state.messages, action.message] };
    case 'send':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: action.userId,
            role: 'user',
            content: action.text,
            tools: [],
            status: 'done',
            ...(action.sentAt ? { createdAt: action.sentAt } : {}),
            ...(action.attachments?.length ? { attachments: action.attachments } : {}),
          },
          {
            id: action.assistantId,
            role: 'assistant',
            content: '',
            tools: [],
            status: 'streaming',
          },
        ],
      };
    case 'approval': {
      const { approval } = action;
      const shown = (message: DisplayMessage) =>
        message.approvals?.some((item) => item.approval_id === approval.approval_id) ?? false;
      if (!state.messages.some(shown)) return state;
      return {
        ...state,
        messages: state.messages.map((message) =>
          shown(message)
            ? {
                ...message,
                approvals: (message.approvals ?? []).map((item) =>
                  item.approval_id === approval.approval_id ? approval : item,
                ),
              }
            : message,
        ),
      };
    }
    case 'finish':
      return updateMessage(state, action.assistantId, (message) => {
        // `done`/`error` events already settled the message; only close dangling streams.
        if (message.status !== 'streaming') return message;
        const next: DisplayMessage = {
          ...message,
          status: action.status,
          tools: settleTools(message.tools),
          steps: [],
        };
        delete next.connection;
        if (action.errorKey) next.errorKey = action.errorKey;
        if (action.retryAt !== undefined) next.retryAt = action.retryAt;
        return next;
      });
  }
}
