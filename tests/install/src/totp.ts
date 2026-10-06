import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// TOTP (RFC 6238, SHA-1, 6 digits, 30 s) with `node:crypto`, and the rule an installation
// enforces: Cognito refuses a code it has already accepted, so a second sign-in of the same
// person has to wait for the next 30 s window.

const STEP_MS = 30_000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** A code typed with less than this left may expire before Cognito reads it. */
const MIN_LEFT_MS = 6_000;

export function base32Decode(secret: string): Buffer {
  let bits = '';
  for (const char of secret.replace(/[\s=-]/g, '').toUpperCase()) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error('The TOTP secret is not base32.');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => Number.parseInt(byte, 2)));
}

export const counterAt = (ms: number): number => Math.floor(ms / STEP_MS);

export function totpAt(secret: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = (digest.at(-1) ?? 0) & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * How long to wait before a code can be used: until a window this person has not used, with
 * enough of it left. `lastUsed` is the counter of the last code this person signed in with.
 */
export function waitBeforeCode(nowMs: number, lastUsed: number | undefined): number {
  let at = nowMs;
  if (lastUsed !== undefined && counterAt(at) <= lastUsed) at = (lastUsed + 1) * STEP_MS;
  if (STEP_MS - (at % STEP_MS) < MIN_LEFT_MS) at = (counterAt(at) + 1) * STEP_MS;
  return at - nowMs;
}

/**
 * Remembers, in a file of the output directory, the last window each person used. It survives a
 * worker restarted after a failure and a second run right after the first. It holds counters
 * under a hash of the address: no address, no secret, no code.
 */
export class TotpLedger {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  #read(): Record<string, number> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, number] =>
          Number.isInteger(entry[1]),
        ),
      );
    } catch {
      return {};
    }
  }

  /** Waits for a window this person has not used and returns its code, marking it as used. */
  async next(email: string, secret: string): Promise<string> {
    const key = createHash('sha256').update(email).digest('hex').slice(0, 16);
    const wait = waitBeforeCode(Date.now(), this.#read()[key]);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait + 250));
    const counter = counterAt(Date.now());
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileSync(this.#file, JSON.stringify({ ...this.#read(), [key]: counter }), { mode: 0o600 });
    return totpAt(secret, counter);
  }
}
