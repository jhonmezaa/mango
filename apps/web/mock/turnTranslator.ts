/**
 * The `v1` stream of a chat turn as the API writes it (`apps/api/src/mango_api/chat_stream.py`,
 * D120): the events of D57 a turn stores, translated into deltas `{c, p, o, v}` over messages
 * `{id, author.role, recipient, channel, content_type, content, status, metadata}`. A pure
 * function of the events: the same events always give the same deltas, numbered from 1, so a
 * connection with `after=<n>` replays them without sending and goes on from `n + 1`.
 *
 * No imports: the mock (Node) and the web's tests share it.
 */

export type Op = 'add' | 'replace' | 'remove' | 'append' | 'truncate' | 'patch';

export interface Delta {
  c: number;
  p: string;
  o: Op;
  v: unknown;
}

export interface TurnEventRecord {
  kind: string;
  data: Record<string, unknown>;
}

export type TurnEnd =
  | { state: 'interrupted' }
  | { state: 'done' }
  | { state: 'failed'; error: { status: number; code: string; message: string } };

export const CANCELLED = { code: 'cancelled', message: 'the turn was stopped' };

/** A field of a stored event as text: only strings are kept (the API's `str()` of a string). */
export const textOf = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

type Status = 'in_progress' | 'finished' | 'error' | 'interrupted';

function message(
  id: string,
  role: string,
  recipient: string,
  channel: string,
  contentType: string,
  content: Record<string, unknown>,
  status: Status,
  metadata: Record<string, unknown>,
  name?: string,
) {
  return {
    id,
    author: name === undefined ? { role } : { role, name },
    recipient,
    channel,
    content_type: contentType,
    content,
    status,
    metadata,
  };
}

export class Translator {
  ended = false;
  private channels = 0;
  private readonly calls = new Map<string, number[]>();
  private finalOpen = false;

  constructor(
    private readonly turnId: string,
    private readonly conversationId: string,
  ) {}

  private id(channel: number): string {
    return `${this.turnId}.${String(channel)}`;
  }

  private next(): number {
    return this.channels++;
  }

  private final(): Delta[] {
    if (this.finalOpen) return [];
    this.finalOpen = true;
    const channel = this.next();
    return [
      {
        c: channel,
        p: '',
        o: 'add',
        v: message(
          this.id(channel),
          'assistant',
          'all',
          'final',
          'text',
          { text: '' },
          'in_progress',
          {
            conversation_id: this.conversationId,
            turn_id: this.turnId,
            phase: null,
            knowledge: [],
            approvals: [],
            connection_required: [],
          },
        ),
      },
    ];
  }

  feed(event: TurnEventRecord): Delta[] {
    if (this.ended) return [];
    const out = this.final();
    const { kind, data } = event;
    if (kind === 'status') {
      const phase: Record<string, string> = { phase: textOf(data.phase, '') };
      if (typeof data.tool === 'string' && data.tool) phase.tool = data.tool;
      out.push({ c: 0, p: '/metadata/phase', o: 'replace', v: phase });
    } else if (kind === 'delta') {
      if (typeof data.text === 'string' && data.text) {
        out.push({ c: 0, p: '/content/text', o: 'append', v: data.text });
      }
    } else if (kind === 'tool') {
      out.push(...this.tool(textOf(data.name, 'tool'), textOf(data.status, '')));
    } else if (kind === 'knowledge') {
      out.push({ c: 0, p: '/metadata/knowledge', o: 'append', v: [data] });
    } else if (kind === 'approval') {
      out.push({ c: 0, p: '/metadata/approvals', o: 'append', v: [data] });
    } else if (kind === 'remote_connection_required') {
      out.push({
        c: 0,
        p: '/metadata/connection_required',
        o: 'append',
        v: [textOf(data.registration_id, '')],
      });
    } else if (kind === 'done') {
      out.push(this.end('finished', '/metadata/result', data));
    } else if (kind === 'error') {
      const error = { code: textOf(data.code, ''), message: textOf(data.message, '') };
      out.push(
        this.end(error.code === CANCELLED.code ? 'interrupted' : 'error', '/metadata/error', error),
      );
    }
    return out;
  }

  /** The end of a turn whose events ended without saying so. */
  close(end: TurnEnd): Delta[] {
    if (this.ended) return [];
    const out = this.final();
    if (end.state === 'interrupted')
      out.push(this.end('interrupted', '/metadata/error', { ...CANCELLED }));
    else if (end.state === 'done') out.push(this.end('finished', '/metadata/result', {}));
    else out.push(this.end('error', '/metadata/error', end.error));
    return out;
  }

  private tool(name: string, status: string): Delta[] {
    const out: Delta[] = [];
    if (status === 'started') {
      const channel = this.next();
      const pending = this.calls.get(name) ?? [];
      pending.push(channel);
      this.calls.set(name, pending);
      out.push({ c: channel, p: '', o: 'add', v: this.call(channel, name) });
      return out;
    }
    let call = this.calls.get(name)?.shift();
    if (call === undefined) {
      call = this.next();
      out.push({ c: call, p: '', o: 'add', v: this.call(call, name) });
    }
    const ended: Status = status === 'error' ? 'error' : 'finished';
    out.push({ c: call, p: '/status', o: 'replace', v: ended });
    const channel = this.next();
    out.push({
      c: channel,
      p: '',
      o: 'add',
      v: message(
        this.id(channel),
        'tool',
        'all',
        'commentary',
        'tool_result',
        {},
        ended,
        { call_id: this.id(call) },
        name,
      ),
    });
    return out;
  }

  private call(channel: number, name: string) {
    return message(
      this.id(channel),
      'assistant',
      name,
      'commentary',
      'tool_call',
      {},
      'in_progress',
      {},
    );
  }

  private end(status: Status, path: string, value: unknown): Delta {
    this.ended = true;
    return {
      c: 0,
      p: '',
      o: 'patch',
      v: [
        { p: '/status', o: 'replace', v: status },
        { p: path, o: 'replace', v: value },
      ],
    };
  }
}

/** Leaves out `c`, `p` and `o` when they repeat the previous delta of the connection. */
export class Compressor {
  private last: [number, string, string] | null = null;

  short(delta: Delta): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const last = this.last;
    if (last?.[0] !== delta.c) out.c = delta.c;
    if (last?.[1] !== delta.p) out.p = delta.p;
    if (last?.[2] !== delta.o) out.o = delta.o;
    out.v = delta.v;
    this.last = [delta.c, delta.p, delta.o];
    return out;
  }
}

export const encodingFrame = () => 'event: delta_encoding\ndata: "v1"\n\n';
export const deltaFrame = (offset: number, delta: Record<string, unknown>) =>
  `id: ${String(offset)}\nevent: delta\ndata: ${JSON.stringify(delta)}\n\n`;
export const completeFrames = (conversationId: string, turnId: string) =>
  `event: message_stream_complete\ndata: ${JSON.stringify({ conversation_id: conversationId, turn_id: turnId })}\n\ndata: [DONE]\n\n`;

/** The deltas of a whole turn, numbered from 1, as one connection with `after` would send them. */
export function framesOf(
  turnId: string,
  conversationId: string,
  events: readonly TurnEventRecord[],
  end: TurnEnd | null,
  after = 0,
): string {
  const translator = new Translator(turnId, conversationId);
  const compressor = new Compressor();
  let offset = 0;
  let body = encodingFrame();
  const send = (deltas: Delta[]) => {
    for (const delta of deltas) {
      offset += 1;
      if (offset > after) body += deltaFrame(offset, compressor.short(delta));
    }
  };
  for (const event of events) send(translator.feed(event));
  if (end) send(translator.close(end));
  if (translator.ended) body += completeFrames(conversationId, turnId);
  return body;
}
