import { describe, expect, it } from 'vitest';

import { MAX_SSE_EVENT_BYTES, SseParser, SseProtocolError } from './sse';

describe('SseParser', () => {
  it('parses complete events with event and data fields', () => {
    const parser = new SseParser();
    const messages = parser.push('event: delta\ndata: {"text":"hola"}\n\n');
    expect(messages).toEqual([{ event: 'delta', data: '{"text":"hola"}' }]);
  });

  it('defaults the event type to "message"', () => {
    expect(new SseParser().push('data: x\n\n')).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('ignores comment lines such as heartbeats', () => {
    const parser = new SseParser();
    expect(parser.push(': ping\n\n')).toEqual([]);
    expect(parser.push(': ping\nevent: done\ndata: {}\n\n')).toEqual([
      { event: 'done', data: '{}' },
    ]);
  });

  it('reassembles events split at arbitrary chunk boundaries', () => {
    const raw =
      'event: tool\ndata: {"name":"get_cost_and_usage","status":"started"}\n\nevent: delta\ndata: {"text":"a"}\n\n';
    for (let size = 1; size <= raw.length; size++) {
      const parser = new SseParser();
      const messages = [];
      for (let i = 0; i < raw.length; i += size)
        messages.push(...parser.push(raw.slice(i, i + size)));
      expect(messages.map((m) => m.event)).toEqual(['tool', 'delta']);
    }
  });

  it('handles CRLF and CR line endings, including CRLF split across chunks', () => {
    const parser = new SseParser();
    expect(parser.push('event: delta\r')).toEqual([]);
    expect(parser.push('\ndata: 1\r\n\r')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'delta', data: '1' }]);
    // A final CR is held until the next chunk shows whether an LF follows.
    expect(new SseParser().push('data: 2\r\r')).toEqual([]);
    expect(new SseParser().push('data: 2\r\rdata: 3')).toEqual([{ event: 'message', data: '2' }]);
  });

  it('joins multi-line data with newlines and strips a single leading space', () => {
    const parser = new SseParser();
    expect(parser.push('data:  a\ndata:b\n\n')).toEqual([{ event: 'message', data: ' a\nb' }]);
  });

  it('skips events without data and ignores id/retry fields', () => {
    const parser = new SseParser();
    expect(parser.push('event: delta\nid: 1\nretry: 10\n\n')).toEqual([]);
  });

  it('discards an unterminated trailing event at the end of the stream', () => {
    const parser = new SseParser();
    expect(parser.push('event: delta\ndata: partial')).toEqual([]);
    expect(parser.end()).toEqual([]);
  });

  it('rejects events larger than the maximum size', () => {
    const parser = new SseParser();
    expect(() => parser.push(`data: ${'x'.repeat(MAX_SSE_EVENT_BYTES + 1)}`)).toThrow(
      SseProtocolError,
    );
  });
});
