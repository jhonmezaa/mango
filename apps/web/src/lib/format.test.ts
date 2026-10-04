import { describe, expect, it } from 'vitest';

import { formatDuration, formatRelative, initialsFor, splitEmail } from './format';

const NOW = Date.parse('2026-09-29T12:00:00Z');

describe('formatRelative', () => {
  it('uses "ahora" for the last seconds and short units after', () => {
    expect(formatRelative('2026-09-29T11:59:40Z', NOW)).toBe('ahora');
    expect(formatRelative('2026-09-29T11:55:00Z', NOW)).toBe('hace 5 min');
    expect(formatRelative('2026-09-29T09:00:00Z', NOW)).toBe('hace 3 h');
    expect(formatRelative('2026-09-28T12:00:00Z', NOW)).toBe('ayer');
  });

  it('falls back to an absolute date after 30 days', () => {
    expect(formatRelative('2026-07-01T12:00:00Z', NOW)).toMatch(/2026/);
  });

  it('returns unparseable input unchanged', () => {
    expect(formatRelative('not-a-date', NOW)).toBe('not-a-date');
  });
});

describe('formatDuration', () => {
  it('uses ms below one second and Spanish decimals above', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(999.4)).toBe('999 ms');
    expect(formatDuration(1000)).toBe('1 s');
    expect(formatDuration(1240)).toBe('1,2 s');
  });

  it('never shows negative durations', () => {
    expect(formatDuration(-5)).toBe('0 ms');
  });
});

describe('initialsFor', () => {
  it('uses the first letters of two name parts', () => {
    expect(initialsFor('ana.perez@example.com')).toBe('AP');
    expect(initialsFor('luis_gomez')).toBe('LG');
  });

  it('uses the first two characters of a single part', () => {
    expect(initialsFor('mock-user@example.com')).toBe('MU');
    expect(initialsFor('x@example.com')).toBe('X');
  });

  it('never returns an empty avatar', () => {
    expect(initialsFor('')).toBe('?');
    expect(initialsFor('@example.com')).toBe('?');
  });
});

describe('splitEmail', () => {
  it('keeps the last six characters of the local part with the domain', () => {
    expect(splitEmail('ana.finops.central@example.com')).toEqual({
      head: 'ana.finops.c',
      tail: 'entral@example.com',
    });
  });

  it('tells apart emails that begin alike', () => {
    const first = splitEmail('equipo.finanzas.norte@example.com');
    const second = splitEmail('equipo.finanzas.sur@example.com');
    expect(first.tail).not.toBe(second.tail);
  });

  it('leaves a short local part and anything that is not an email whole', () => {
    expect(splitEmail('ana@example.com')).toEqual({ head: '', tail: 'ana@example.com' });
    expect(splitEmail('sub-123')).toEqual({ head: 'sub-123', tail: null });
    expect(splitEmail('')).toEqual({ head: '', tail: null });
  });
});
