import type { ChatEvent } from '../api/chatEvents';
import type { ChatApproval, Message, ToolCall, ToolStatus } from '../api/schemas';

export type MessageStatus = 'streaming' | 'done' | 'error' | 'stopped';

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

/** What the agent is doing while the turn streams (SSE `status`); structured, never model text. */
export type ProgressPhase = 'thinking' | 'tool' | 'tool_result' | 'writing';

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

function closeSteps(steps: readonly TurnStep[], keep: (step: TurnStep) => boolean): TurnStep[] {
  return steps.map((step) =>
    step.status === 'running' && !keep(step) ? { ...step, status: 'ok' } : step,
  );
}

const isToolStep = (step: TurnStep) => step.kind === 'tool';

/** A phase of the turn began: what was running (except tools, which report on their own) ends. */
function stepsOnPhase(steps: readonly TurnStep[], phase: ProgressPhase): TurnStep[] {
  const next = closeSteps(steps, (step) => isToolStep(step) || step.kind === phase);
  if (phase === 'tool' || next.some((step) => step.kind === phase && step.status === 'running')) {
    return next;
  }
  return [...next, { id: next.length, kind: phase, status: 'running' }];
}

/** A tool started or ended: its own step, matched by name like the tool list. */
function stepsOnTool(steps: readonly TurnStep[], tool: ToolCall): TurnStep[] {
  if (tool.status === 'started') {
    const next = closeSteps(steps, isToolStep);
    return [...next, { id: next.length, kind: 'tool', tool: tool.name, status: 'running' }];
  }
  const index = steps.findLastIndex(
    (step) => isToolStep(step) && step.tool === tool.name && step.status === 'running',
  );
  if (index < 0) return [...steps];
  const status = tool.status === 'error' ? 'failed' : 'ok';
  return steps.map((step, i) => (i === index ? { ...step, status } : step));
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
  /** ISO timestamp: `created_at` for loaded history, the client clock for messages sent now. */
  createdAt?: string;
  errorKey?: ErrorKey;
  usage?: { inputTokens: number; outputTokens: number; costUsd: string };
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
  | 'errors.streamInterrupted';

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
};

/** Maps a backend error code to a localized message; the backend text is never shown raw. */
export function errorKeyForCode(code: string, status?: number): ErrorKey {
  const known = ERROR_KEYS[code];
  if (known) return known;
  if (status === 402) return 'errors.budget_exceeded';
  if (status === 403) return 'errors.forbidden';
  if (status === 422) return 'errors.invalid_message';
  return 'errors.generic';
}

export type ChatAction =
  | { type: 'reset'; conversationId: string | null; messages: DisplayMessage[] }
  | { type: 'send'; userId: string; assistantId: string; text: string; sentAt?: string }
  | {
      type: 'event';
      assistantId: string;
      event: ChatEvent;
      /** Client clock (ms) when the event arrived; used to time tool calls. */
      receivedAt?: number;
    }
  /** A request changed (confirmed, signed, run…): replace it wherever it is shown. */
  | { type: 'approval'; approval: ChatApproval }
  | {
      type: 'finish';
      assistantId: string;
      status: Exclude<MessageStatus, 'streaming'>;
      errorKey?: ErrorKey;
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
    status: 'done',
    createdAt: message.created_at,
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

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return { conversationId: action.conversationId, messages: action.messages };
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
    case 'event': {
      const { event, assistantId } = action;
      switch (event.type) {
        case 'conversation':
          return { ...state, conversationId: event.conversation_id };
        case 'tool':
          return updateMessage(state, assistantId, (message) => ({
            ...message,
            tools: upsertTool(
              message.tools,
              { name: event.name, status: event.status },
              action.receivedAt,
            ),
            steps: stepsOnTool(message.steps ?? [], { name: event.name, status: event.status }),
          }));
        case 'approval':
          return updateMessage(state, assistantId, (message) => ({
            ...message,
            approvals: [...(message.approvals ?? []), event.approval],
          }));
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
        case 'delta':
          return updateMessage(state, assistantId, (message) => ({
            ...message,
            content: message.content + event.text,
          }));
        case 'done':
          return updateMessage(state, assistantId, (message) => ({
            ...message,
            status: 'done',
            tools: settleTools(message.tools),
            steps: [],
            ...(event.stop_reason === GUARDRAIL_STOP ? { guardrail: true } : {}),
            usage: {
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
              costUsd: event.cost_usd,
            },
          }));
        case 'error':
          return updateMessage(state, assistantId, (message) => ({
            ...message,
            status: 'error',
            tools: settleTools(message.tools),
            steps: [],
            errorKey: errorKeyForCode(event.code),
          }));
      }
      return state;
    }
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
        if (action.errorKey) next.errorKey = action.errorKey;
        return next;
      });
  }
}
