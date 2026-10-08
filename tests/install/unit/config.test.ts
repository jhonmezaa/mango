import { describe, expect, it } from 'vitest';

import example from '../config.example.json' with { type: 'json' };
import { assertOutsideRepo, parseEffects, parseInstallFile } from '../src/config.ts';

describe('parseInstallFile', () => {
  it('accepts the example of the repository, which holds only placeholders', () => {
    const parsed = parseInstallFile(example);
    expect(parsed.chat?.role).toBe('areaMember');
    expect(JSON.stringify(example)).toMatch(/app\.example\.com/);
    expect(JSON.stringify(example)).not.toMatch(/cloudfront|\d{12}/);
  });

  it('names the wrong fields without repeating their values', () => {
    const wrong = {
      ...example,
      baseUrl: 'http://app.example.com',
      users: { admin: { email: 'not-an-address' } },
      people: { emailDomain: 'empresa.com' },
      extra: true,
    };
    expect(() => parseInstallFile(wrong)).toThrow(
      /baseUrl.*users\.admin\.email.*people\.emailDomain|check:/,
    );
    try {
      parseInstallFile(wrong);
    } catch (error) {
      expect(String(error)).not.toContain('not-an-address');
    }
  });

  it('wants only the origin of the installation', () => {
    expect(() => parseInstallFile({ ...example, baseUrl: 'https://app.example.com/chat' })).toThrow(
      'baseUrl',
    );
  });

  it('takes the namespace of the installation only in the shape a namespace has', () => {
    expect(parseInstallFile(example).aws).toEqual({ profile: 'mango', namespace: 'acme' });
    expect(parseInstallFile({ ...example, aws: { namespace: 'acme' } }).aws?.profile).toBe(
      undefined,
    );
    // It ends up in the name of a harness the AWS CLI is asked for.
    for (const namespace of ['Acme', 'a', 'acme-prod', 'acme_a_x', '']) {
      expect(() => parseInstallFile({ ...example, aws: { namespace } })).toThrow('aws.namespace');
    }
  });

  it('only lets a disposable person live under .invalid', () => {
    expect(() => parseInstallFile({ ...example, people: { emailDomain: 'gmail.com' } })).toThrow(
      'people.emailDomain',
    );
  });
});

describe('parseEffects', () => {
  it('is read-only unless an effect is asked for', () => {
    expect([...parseEffects(undefined)]).toEqual([]);
    expect([...parseEffects('')]).toEqual([]);
    expect([...parseEffects('chat')]).toEqual(['chat']);
    expect([...parseEffects(' people , chat ')].sort()).toEqual(['chat', 'people']);
    expect([...parseEffects('all')].sort()).toEqual(['chat', 'people']);
  });

  it('refuses a name it does not know instead of ignoring it', () => {
    expect(() => parseEffects('chta')).toThrow('MANGO_INSTALL_EFFECTS');
  });
});

describe('assertOutsideRepo', () => {
  it('refuses a config, secrets or output path inside the repository', () => {
    expect(() => {
      assertOutsideRepo('/repo/tests/install/config.json', 'It', '/repo');
    }).toThrow('outside the repository');
    expect(() => {
      assertOutsideRepo('/repo', 'It', '/repo');
    }).toThrow();
    expect(() => {
      assertOutsideRepo('/home/someone/.config/mango/x.json', 'It', '/repo');
    }).not.toThrow();
    expect(() => {
      assertOutsideRepo('/repo-other/x.json', 'It', '/repo');
    }).not.toThrow();
  });
});
