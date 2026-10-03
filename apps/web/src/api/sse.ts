/** One Server-Sent Event as defined by the WHATWG EventSource parsing rules. */
export interface SseMessage {
  event: string;
  data: string;
}

/** Upper bound for a single buffered event, to cap memory use on a misbehaving stream. */
export const MAX_SSE_EVENT_BYTES = 1_000_000;

export class SseProtocolError extends Error {
  override name = 'SseProtocolError';
}

/**
 * Incremental text/event-stream parser. Feed decoded text chunks with `push`; complete events are
 * returned as soon as their terminating blank line arrives. Comment lines (`: ping` heartbeats)
 * and `id`/`retry` fields are ignored because the chat stream does not use reconnection.
 */
export class SseParser {
  private buffer = '';
  private eventType = '';
  private dataLines: string[] = [];
  private pendingBytes = 0;

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A trailing lone CR may be the first half of CRLF split across chunks.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const message = this.processLine(line);
      if (message) messages.push(message);
    }
    if (this.buffer.length + this.pendingBytes > MAX_SSE_EVENT_BYTES) {
      throw new SseProtocolError('SSE event exceeds the maximum size');
    }
    return messages;
  }

  /** Flushes the stream end. Per the spec an unterminated final event is discarded. */
  end(): SseMessage[] {
    this.buffer = '';
    this.reset();
    return [];
  }

  private processLine(line: string): SseMessage | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      this.eventType = value;
    } else if (field === 'data') {
      this.dataLines.push(value);
      this.pendingBytes += value.length;
    }
    return null;
  }

  private dispatch(): SseMessage | null {
    if (this.dataLines.length === 0) {
      this.reset();
      return null;
    }
    const message = { event: this.eventType || 'message', data: this.dataLines.join('\n') };
    this.reset();
    return message;
  }

  private reset(): void {
    this.eventType = '';
    this.dataLines = [];
    this.pendingBytes = 0;
  }
}
