import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { base32Decode, counterAt, totpAt, TotpLedger, waitBeforeCode } from '../src/totp.ts';

// RFC 6238, appendix B: the SHA-1 seed is the ASCII text `12345678901234567890`.
const RFC_SEED_TEXT = '12345678901234567890';

function base32(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...bytes].map((byte) => byte.toString(2).padStart(8, '0')).join('');
  return (bits.match(/.{1,5}/g) ?? [])
    .map((chunk) => alphabet.charAt(Number.parseInt(chunk.padEnd(5, '0'), 2)))
    .join('');
}

const RFC_SEED = base32(Buffer.from(RFC_SEED_TEXT, 'ascii'));

describe('totpAt', () => {
  it('gives the codes of the RFC 6238 test vectors (last six digits)', () => {
    expect(base32Decode(RFC_SEED).toString('ascii')).toBe(RFC_SEED_TEXT);
    expect(totpAt(RFC_SEED, counterAt(59_000))).toBe('287082');
    expect(totpAt(RFC_SEED, counterAt(1_111_111_109_000))).toBe('081804');
    expect(totpAt(RFC_SEED, counterAt(1_234_567_890_000))).toBe('005924');
    expect(totpAt(RFC_SEED, counterAt(20_000_000_000_000))).toBe('353130');
  });

  it('reads a secret written in groups, in lower case or with padding', () => {
    const written = `${(RFC_SEED.toLowerCase().match(/.{4}/g) ?? []).join(' ')}====`;
    expect(totpAt(written, 1)).toBe(totpAt(RFC_SEED, 1));
    expect(() => base32Decode('not base32 !')).toThrow('not base32');
  });
});

describe('waitBeforeCode', () => {
  const window = (n: number) => n * 30_000;

  it('does not wait in a fresh window nobody used', () => {
    expect(waitBeforeCode(window(10) + 5_000, undefined)).toBe(0);
    expect(waitBeforeCode(window(10) + 5_000, 9)).toBe(0);
  });

  it('waits for the next window when this person already used the current one', () => {
    expect(waitBeforeCode(window(10) + 5_000, 10)).toBe(25_000);
  });

  it('waits for the next window when the current one is about to end', () => {
    expect(waitBeforeCode(window(10) + 27_000, undefined)).toBe(3_000);
  });
});

describe('TotpLedger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-check-'));
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never hands the same window twice to one person, and keeps no address or code', async () => {
    vi.useFakeTimers({ now: 10 * 30_000 + 1_000 });
    const file = join(dir, 'windows.json');
    const ledger = new TotpLedger(file);
    const first = await ledger.next('nombre@empresa.com', RFC_SEED);
    expect(first).toBe(totpAt(RFC_SEED, 10));

    // A second ledger on the same file: another worker, or the next run.
    const second = new TotpLedger(file).next('nombre@empresa.com', RFC_SEED);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await second).toBe(totpAt(RFC_SEED, 11));

    // Another person is not held back by the first one.
    expect(await ledger.next('otra@empresa.com', RFC_SEED)).toBe(totpAt(RFC_SEED, 11));
    const stored = readFileSync(file, 'utf8');
    expect(stored).not.toMatch(/empresa|@/);
    expect(stored).not.toContain(RFC_SEED);
    expect(stored).not.toContain(first);
    rmSync(dir, { recursive: true });
  });
});
