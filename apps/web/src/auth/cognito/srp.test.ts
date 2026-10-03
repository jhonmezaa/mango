import { describe, expect, it } from 'vitest';

import vectors from './srp.vectors.json';
import { cognitoTimestamp, padHex, passwordClaim, sessionFromSmallA, startSession } from './srp';

// Vectors generated with an independent implementation: pycognito 2024.5.1,
// AWSSRP.process_challenge, with a fixed `a` and timestamp (see srp.vectors.json `source`).
describe('Cognito SRP', () => {
  it.each(vectors.cases)('matches the reference for $userIdForSrp', async (c) => {
    const session = sessionFromSmallA(c.smallA);
    expect(session.largeA).toBe(c.A);
    const signature = await passwordClaim(
      session,
      c.poolId,
      { userIdForSrp: c.userIdForSrp, salt: c.salt, srpB: c.B, secretBlock: c.block },
      c.password,
      c.timestamp,
    );
    expect(signature).toBe(c.signature);
  });

  it('fails with a wrong password', async () => {
    const [c] = vectors.cases;
    if (!c) throw new Error('no vectors');
    const signature = await passwordClaim(
      sessionFromSmallA(c.smallA),
      c.poolId,
      { userIdForSrp: c.userIdForSrp, salt: c.salt, srpB: c.B, secretBlock: c.block },
      `${c.password}x`,
      c.timestamp,
    );
    expect(signature).not.toBe(c.signature);
  });

  it.each(vectors.timestamps)('formats %s as %s', (iso, expected) => {
    expect(cognitoTimestamp(new Date(iso))).toBe(expected);
  });

  it('pads hex like amazon-cognito-identity-js', () => {
    expect(padHex('abc')).toBe('0abc');
    expect(padHex('8f')).toBe('008f');
    expect(padHex('7f')).toBe('7f');
    expect(padHex(255n)).toBe('00ff');
  });

  it('rejects malicious server values', async () => {
    const [c] = vectors.cases;
    if (!c) throw new Error('no vectors');
    const challenge = { userIdForSrp: 'u', salt: c.salt, srpB: '0', secretBlock: c.block };
    const session = sessionFromSmallA(c.smallA);
    await expect(passwordClaim(session, c.poolId, challenge, 'p', 't')).rejects.toThrow();
    await expect(
      passwordClaim(session, c.poolId, { ...challenge, srpB: 'zz' }, 'p', 't'),
    ).rejects.toThrow();
    await expect(
      passwordClaim(session, 'nopool', { ...challenge, srpB: c.B }, 'p', 't'),
    ).rejects.toThrow();
  });

  it('draws a fresh random a for each session', () => {
    const first = startSession();
    const second = startSession();
    expect(first.largeA).not.toBe(second.largeA);
    expect(first.largeA.length).toBeGreaterThan(700);
  });
});
