import { describe, expect, it } from 'vitest';

import {
  CONNECTION_START,
  DeltaError,
  NOT_STARTED,
  NO_CHANNELS,
  applyDelta,
  inherit,
  receiveDelta,
  startConnection,
  type Channels,
  type Connection,
  type Json,
} from './deltas';

/** Applies raw deltas of one connection, like the reference applier's `feed`. */
function feed(raws: unknown[], channels: Channels = NO_CHANNELS): Channels {
  let connection: Connection = startConnection('v1');
  let current = channels;
  for (const raw of raws) {
    const next = receiveDelta(connection, current, raw);
    connection = next.connection;
    current = next.channels;
  }
  return current;
}

const MESSAGE: Json = {
  id: 't.0',
  author: { role: 'assistant' },
  content: { text: '' },
  status: 'in_progress',
  metadata: { knowledge: [] },
};

describe('v1 deltas', () => {
  it('needs delta_encoding v1 before any delta', () => {
    expect(() => receiveDelta(NOT_STARTED, NO_CHANNELS, { v: 1 })).toThrow(DeltaError);
    expect(() => startConnection('v2')).toThrow(DeltaError);
    expect(startConnection('v1')).toEqual({ started: true, previous: CONNECTION_START });
  });

  it('inherits c, p and o from the previous delta, never v', () => {
    const channels = feed([
      { c: 0, p: '', o: 'add', v: MESSAGE },
      { p: '/content/text', o: 'append', v: 'Hola' },
      { v: ', ' },
      { v: 'mundo' },
    ]);
    expect(channels.get(0)).toMatchObject({ content: { text: 'Hola, mundo' } });
    // `v` is never inherited: a delta without it is refused (except `remove`).
    expect(() => inherit({ c: 0, p: '/x', o: 'append' }, {})).toThrow('v is never inherited');
    expect(inherit({ c: 2, p: '/x', o: 'append' }, { o: 'remove' })).toEqual({
      c: 2,
      p: '/x',
      o: 'remove',
      v: undefined,
    });
  });

  it('starts every connection from {c: 0, p: "", o: "add"} and keeps the documents', () => {
    const first = feed([
      { c: 0, p: '', o: 'add', v: MESSAGE },
      { p: '/content/text', o: 'append', v: 'Ho' },
    ]);
    // A new connection: without c/p/o, the first delta is an `add` at the root of channel 0.
    const resumed = feed([{ c: 0, p: '/content/text', o: 'append', v: 'la' }], first);
    expect(resumed.get(0)).toMatchObject({ content: { text: 'Hola' } });
    const replaced = feed([{ v: { id: 'other' } }], first);
    expect(replaced.get(0)).toEqual({ id: 'other' });
  });

  it('keeps one document per channel', () => {
    const channels = feed([
      { c: 0, p: '', o: 'add', v: MESSAGE },
      { c: 1, v: { id: 't.1', status: 'in_progress' } },
      { p: '/status', o: 'replace', v: 'finished' },
    ]);
    expect(channels.get(0)).toMatchObject({ status: 'in_progress' });
    expect(channels.get(1)).toEqual({ id: 't.1', status: 'finished' });
  });

  it('applies add, replace, remove, append, truncate and patch', () => {
    const channels = feed([
      { c: 0, p: '', o: 'add', v: { text: 'abcdef', list: [1, 2, 3], meta: { a: 1 } } },
      { p: '/text', o: 'truncate', v: 3 },
      { p: '/list', o: 'truncate', v: 1 },
      { p: '/list/0', o: 'add', v: 0 },
      { p: '/list', o: 'append', v: [7, 8] },
      { p: '/meta', o: 'append', v: { b: 2 } },
      { p: '/meta/a', o: 'remove' },
      { p: '/gone', o: 'remove' },
      {
        p: '',
        o: 'patch',
        v: [
          { p: '/status', o: 'replace', v: 'finished' },
          { p: '/meta/c', o: 'add', v: 3 },
        ],
      },
    ]);
    expect(channels.get(0)).toEqual({
      text: 'abc',
      list: [0, 1, 7, 8],
      meta: { b: 2, c: 3 },
      status: 'finished',
    });
  });

  it('decodes JSON Pointers and creates the parents that are missing', () => {
    const channels = feed([
      { c: 3, p: '/a~1b/c~0d', o: 'add', v: 1 },
      { p: '/items/0/name', o: 'add', v: 'x' },
    ]);
    expect(channels.get(3)).toEqual({ 'a/b': { 'c~d': 1 }, items: [{ name: 'x' }] });
  });

  it.each(['__proto__', 'constructor', 'prototype'])('refuses the key %s', (key) => {
    const base = feed([{ c: 0, p: '', o: 'add', v: { meta: {} } }]);
    expect(() => feed([{ c: 0, p: `/${key}/polluted`, o: 'add', v: true }], base)).toThrow(
      'Unsafe delta path segment',
    );
    expect(() => feed([{ c: 0, p: `/meta/${key}`, o: 'replace', v: 1 }], base)).toThrow(DeltaError);
    // An object appended onto another cannot bring the key either.
    const unsafe = JSON.parse(`{"${key}": {"polluted": true}}`) as Json;
    expect(() => feed([{ c: 0, p: '/meta', o: 'append', v: unsafe }], base)).toThrow(DeltaError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses unknown operations, bad channels and paths through values', () => {
    const base = feed([{ c: 0, p: '', o: 'add', v: { text: 'a' } }]);
    expect(() => feed([{ c: 0, p: '/x', o: 'move', v: 1 }], base)).toThrow('Unknown operation');
    expect(() => feed([{ c: -1, p: '', o: 'add', v: 1 }], base)).toThrow('Bad channel');
    expect(() => feed([{ c: 0, p: '/text/deeper', o: 'add', v: 1 }], base)).toThrow(DeltaError);
    expect(() => feed([{ c: 0, p: '', o: 'patch', v: [{ p: '/a' }] }], base)).toThrow(DeltaError);
    const listed = feed([{ c: 0, p: '', o: 'add', v: { list: [1] } }]);
    expect(() => feed([{ c: 0, p: '/list/x', o: 'remove' }], listed)).toThrow(DeltaError);
  });

  it('never changes the documents it was given, and leaves them whole when a delta fails', () => {
    const document: Json = { content: { text: 'Hola' }, list: [1], meta: { other: { deep: 1 } } };
    const before = new Map([[0, document]]) as Channels;
    const snapshot = JSON.stringify(document);
    const after = applyDelta(before, { c: 0, p: '/content/text', o: 'append', v: '!' });
    expect(JSON.stringify(document)).toBe(snapshot);
    expect(before.get(0)).toBe(document);
    expect(after.get(0)).toMatchObject({ content: { text: 'Hola!' } });
    // What did not change is shared, not copied.
    expect((after.get(0) as { meta: Json }).meta).toBe((document as { meta: Json }).meta);
    // A patch that fails halfway leaves nothing applied.
    expect(() =>
      applyDelta(before, {
        c: 0,
        p: '',
        o: 'patch',
        v: [
          { p: '/status', o: 'replace', v: 'finished' },
          { p: '/__proto__', o: 'replace', v: 1 },
        ],
      }),
    ).toThrow(DeltaError);
    expect(JSON.stringify(before.get(0))).toBe(snapshot);
  });
});
