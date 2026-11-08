import { describe, expect, it } from 'vitest';

import type { Channels, Json } from '../api/deltas';
import { messageSchema } from '../api/schemas';
import { chatReducer, fromApiMessage, initialChatState } from './chatState';
import { announcedFiles, codeFileCards, codeFigures, fileSize } from './codeBlock';
import { EMPTY_TURN, turnViewOf } from './turnView';

const TURN = 't'.repeat(32);
const FIGURE = {
  file_id: '01' + 'A'.repeat(24),
  name: 'g.png',
  kind: 'png',
  size_bytes: 1,
  role: 'figure' as const,
  image: true,
};
const SHEET = {
  file_id: '01' + 'B'.repeat(24),
  name: 'd.xlsx',
  kind: 'xlsx',
  size_bytes: 1,
  role: 'file' as const,
  image: false,
};
const CELL = {
  run_id: 'ab12',
  status: 'completed',
  blocked: false,
  code: 'print(1)',
  stdout: '1',
  stderr: '',
  stdout_truncated: false,
  stderr_truncated: false,
  exception: null,
  seconds: 1,
  files: [FIGURE, SHEET],
};

const answer = (status = 'in_progress'): Json => ({
  id: `${TURN}.0`,
  author: { role: 'assistant' },
  recipient: 'all',
  channel: 'final',
  content_type: 'text',
  content: { text: '' },
  status,
  metadata: { phase: { phase: 'code' } },
});
const call = (channel: number, status = 'in_progress'): Json => ({
  id: `${TURN}.${String(channel)}`,
  author: { role: 'assistant' },
  recipient: 'code.run_python',
  channel: 'commentary',
  content_type: 'code',
  content: {},
  status,
  metadata: {},
});
const result = (callChannel: number | null, cell: Json | null): Json => ({
  id: `${TURN}.9`,
  author: { role: 'tool', name: 'code.run_python' },
  recipient: 'all',
  channel: 'commentary',
  content_type: 'code_result',
  content: {},
  status: 'finished',
  metadata: {
    call_id: callChannel === null ? null : `${TURN}.${String(callChannel)}`,
    aggregate_result: cell,
  },
});

describe('turnViewOf · cells of the sandbox (C4)', () => {
  it('pairs each cell with its call and counts the calls still running', () => {
    const channels: Channels = new Map<number, Json>([
      [0, answer()],
      [1, call(1, 'finished')],
      [2, result(1, CELL)],
      [3, call(3)],
    ]);
    const view = turnViewOf(channels);
    expect(view.code.cells.map((c) => c.run_id)).toEqual(['ab12']);
    expect(view.code.pending).toBe(1);
    expect(view.tools).toEqual([
      { name: 'code.run_python', status: 'completed' },
      { name: 'code.run_python', status: 'started' },
    ]);
    expect(view.phase).toEqual({ phase: 'code' });
  });

  it('leaves out a cell that does not have the shape of the API', () => {
    const channels: Channels = new Map<number, Json>([
      [0, answer()],
      [1, call(1, 'finished')],
      [2, result(1, { ...CELL, stdout: 'x'.repeat(20_001) })],
    ]);
    const view = turnViewOf(channels);
    expect(view.code.cells).toEqual([]);
    expect(view.code.pending).toBe(1);
  });

  it('keeps a cell that came without a call waiting for it', () => {
    const channels: Channels = new Map<number, Json>([
      [0, answer()],
      [1, result(null, CELL)],
    ]);
    expect(turnViewOf(channels).code.cells).toHaveLength(1);
  });

  it('a recipient the API did not mark as a cell is a plain tool call', () => {
    const fake = {
      ...(call(1) as object),
      content_type: 'tool_call',
      recipient: 'run_python',
    } as Json;
    const view = turnViewOf(
      new Map<number, Json>([
        [0, answer()],
        [1, fake],
      ]),
    );
    expect(view.code).toEqual({ cells: [], pending: 0 });
  });
});

describe('chatState · the block of an answer (C4)', () => {
  const sent = chatReducer(initialChatState, {
    type: 'send',
    userId: 'u',
    assistantId: 'a',
    text: 'hola',
  });

  it('follows the view and forgets the calls refused before they ran once the turn ends', () => {
    const running = turnViewOf(
      new Map<number, Json>([
        [0, answer()],
        [1, call(1)],
      ]),
    );
    let state = chatReducer(sent, {
      type: 'turn',
      assistantId: 'a',
      previous: EMPTY_TURN,
      view: running,
    });
    expect(state.messages[1]?.code).toEqual({ cells: [], pending: 1 });
    expect(state.messages[1]?.steps?.at(-1)).toMatchObject({ kind: 'code', status: 'running' });
    const done = { ...running, status: 'finished' as const, result: {} };
    state = chatReducer(state, { type: 'turn', assistantId: 'a', previous: running, view: done });
    expect(state.messages[1]?.code?.pending).toBe(0);
  });

  it('reads the cells of a stored answer and leaves out one that does not parse', () => {
    const stored = messageSchema.parse({
      message_id: 'm',
      role: 'assistant',
      content: 'Listo',
      created_at: '2026-11-08T00:00:00Z',
      tools: [],
      code: [CELL, { nope: true }],
    });
    expect(fromApiMessage(stored).code?.cells.map((c) => c.run_id)).toEqual(['ab12']);
  });

  it('splits the files into figures and cards, and announces all of them to the links', () => {
    const block = {
      cells: [
        {
          ...CELL,
          files: [FIGURE, SHEET, { ...FIGURE, file_id: '01' + 'C'.repeat(24), gone: true }],
        },
      ],
      pending: 0,
    } as never;
    expect(codeFigures(block).map((f) => f.name)).toEqual(['g.png']);
    expect(codeFileCards(block).map((f) => f.kind)).toEqual(['xlsx', 'png']);
    expect(announcedFiles(block)).toHaveLength(3);
  });

  it('sizes a file as the design does', () => {
    expect(fileSize(88_400)).toBe('86 KB');
    expect(fileSize(2 * 1_048_576)).toMatch(/^2 MB$/);
  });
});
