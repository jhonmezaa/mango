/**
 * Client side of Cognito's SRP-6a variant (`USER_SRP_AUTH` + `PASSWORD_VERIFIER`), D20.
 *
 * Why here and not a library (TM-L1): the maintained options either pull the Amplify legacy
 * stack (`amazon-cognito-identity-js`, which defaults to localStorage) or several unaudited
 * crypto dependencies (`cognito-srp-helper`: aws-sdk + crypto-js + jsbn + buffer). This module
 * has no dependencies: `BigInt` for the group arithmetic and WebCrypto for SHA-256/HMAC. It is
 * checked against vectors from an independent implementation (pycognito) in `srp.test.ts`.
 *
 * The password only lives in the arguments of `passwordClaim` and is never stored or logged.
 */

// RFC 5054 3072-bit group, as used by Cognito (amazon-cognito-identity-js AuthenticationHelper).
const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
  'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';
const N = BigInt(`0x${N_HEX}`);
const G = 2n;
const INFO = new TextEncoder().encode('Caldera Derived Key\u0001');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HEX_RE = /^[0-9a-fA-F]+$/;

export class SrpError extends Error {
  override name = 'SrpError';
}

function mod(value: bigint, modulus: bigint): bigint {
  const r = value % modulus;
  return r < 0n ? r + modulus : r;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = mod(base, modulus);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

function toHex(value: bigint): string {
  return value.toString(16);
}

/** Cognito's padHex: even length, and a leading 00 when the high bit is set (positive only). */
export function padHex(value: bigint | string): string {
  let hex = typeof value === 'string' ? value : toHex(value);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  else if ('89abcdefABCDEF'.includes(hex[0] ?? '')) hex = `00${hex}`;
  return hex;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 === 1 || (hex.length > 0 && !HEX_RE.test(hex))) {
    throw new SrpError('invalid hex');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

async function hexHash(hex: string): Promise<string> {
  return bytesToHex(await sha256(hexToBytes(hex))).padStart(64, '0');
}

async function hmacSha256(
  key: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data));
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** `k = H(N | g)` with Cognito's padding (`00` + N, `0` + g). */
const kPromise: Promise<bigint> = hexHash(`00${N_HEX}0${toHex(G)}`).then((h) => BigInt(`0x${h}`));

/** Cognito's timestamp: `Wed Sep 30 12:05:09 UTC 2026` (day not padded). */
export function cognitoTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC ` +
    `${date.getUTCFullYear()}`
  );
}

export interface SrpSession {
  /** Client public value `A`, sent as `SRP_A`. */
  readonly largeA: string;
  readonly smallA: bigint;
}

/** New ephemeral `a` (256 random bytes) and `A = g^a mod N`. */
export function startSession(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (b) =>
    crypto.getRandomValues(b),
): SrpSession {
  for (;;) {
    const smallA = mod(BigInt(`0x${bytesToHex(random(new Uint8Array(128)))}`), N);
    if (smallA === 0n) continue;
    const largeA = modPow(G, smallA, N);
    if (largeA % N !== 0n) return { smallA, largeA: toHex(largeA) };
  }
}

/** Deterministic session from a known `a` (test vectors only). */
export function sessionFromSmallA(smallAHex: string): SrpSession {
  const smallA = BigInt(`0x${smallAHex}`);
  return { smallA, largeA: toHex(modPow(G, smallA, N)) };
}

export interface PasswordVerifierChallenge {
  userIdForSrp: string;
  salt: string;
  srpB: string;
  secretBlock: string;
}

/**
 * `PASSWORD_CLAIM_SIGNATURE` for the `PASSWORD_VERIFIER` challenge.
 *
 * x = H(salt | H(poolName | userId | ":" | password)), u = H(A | B),
 * S = (B - k·g^x)^(a + u·x) mod N, key = HKDF(S, u)[0..16],
 * signature = HMAC(key, poolName | userId | secretBlock | timestamp).
 */
export async function passwordClaim(
  session: SrpSession,
  poolId: string,
  challenge: PasswordVerifierChallenge,
  password: string,
  timestamp: string,
): Promise<string> {
  const poolName = poolId.split('_')[1];
  if (!poolName) throw new SrpError('invalid user pool id');
  if (!HEX_RE.test(challenge.srpB) || !HEX_RE.test(challenge.salt)) {
    throw new SrpError('invalid challenge');
  }
  const largeB = BigInt(`0x${challenge.srpB}`);
  if (largeB % N === 0n) throw new SrpError('invalid server value');
  const largeA = BigInt(`0x${session.largeA}`);
  const u = BigInt(`0x${await hexHash(padHex(largeA) + padHex(largeB))}`);
  if (u === 0n) throw new SrpError('invalid server value');

  const encoder = new TextEncoder();
  const identity = bytesToHex(
    await sha256(encoder.encode(`${poolName}${challenge.userIdForSrp}:${password}`)),
  ).padStart(64, '0');
  const x = BigInt(`0x${await hexHash(padHex(challenge.salt) + identity)}`);
  const k = await kPromise;
  const base = mod(largeB - k * modPow(G, x, N), N);
  const s = modPow(base, session.smallA + u * x, N);

  const prk = await hmacSha256(hexToBytes(padHex(u)), hexToBytes(padHex(s)));
  const key = (await hmacSha256(prk, INFO)).slice(0, 16);
  const message = concat(
    encoder.encode(poolName),
    encoder.encode(challenge.userIdForSrp),
    base64ToBytes(challenge.secretBlock),
    encoder.encode(timestamp),
  );
  return bytesToBase64(await hmacSha256(key, message));
}
