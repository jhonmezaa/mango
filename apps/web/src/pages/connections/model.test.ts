import i18n from 'i18next';
import { describe, expect, it } from 'vitest';

import '../../i18n';
import { ApiError } from '../../api/errors';
import {
  connectErrorOf,
  consentUrl,
  idpsOf,
  linkSourcesOf,
  returnResultOf,
  returnResultOfQuery,
  rowStateOf,
} from './model';
import { connection } from './testFixtures';

const AWS = 'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/authorize?x=1';

describe('consentUrl', () => {
  it('only lets the AgentCore host of the region through', () => {
    expect(consentUrl(AWS, 'us-east-1')).toBe(AWS);
    for (const value of [
      null,
      '',
      'http://bedrock-agentcore.us-east-1.amazonaws.com/x',
      'https://bedrock-agentcore.us-west-2.amazonaws.com/x',
      'https://bedrock-agentcore.us-east-1.amazonaws.com.example.net/x',
      'https://login.microsoftonline.com/x',
      'https://user:pass@bedrock-agentcore.us-east-1.amazonaws.com/x',
      'https://bedrock-agentcore.us-east-1.amazonaws.com:8443/x',
      'javascript:alert(1)',
      `${AWS}&p=${'a'.repeat(2048)}`,
    ]) {
      expect(consentUrl(value, 'us-east-1'), String(value)).toBeNull();
    }
  });
});

describe('rowStateOf', () => {
  it('follows the design states', () => {
    expect(rowStateOf(connection(), false)).toBe('none');
    expect(rowStateOf(connection(), true)).toBe('opening');
    expect(rowStateOf(connection({ status: 'connected' }), false)).toBe('on');
    expect(rowStateOf(connection({ status: 'secret_expired' }), false)).toBe('blocked');
    expect(rowStateOf(connection({ status: 'disabled' }), true)).toBe('off');
  });
});

describe('idpsOf', () => {
  it('names each provider once and falls back to the service', () => {
    expect(
      idpsOf([
        connection(),
        connection({ registration_id: 'klmnopqrst45' }),
        connection({ provider: null, service: 'Otro' }),
      ]),
    ).toEqual(['Microsoft', 'Otro']);
  });
});

describe('linkSourcesOf', () => {
  it('uses every organization of the profile the person may use', () => {
    const list = [
      connection(),
      connection({ registration_id: 'klmnopqrst45', organization: 'empresa-labs' }),
    ];
    expect(linkSourcesOf(['abcdefghij23', 'unknownregxx'], list)).toEqual([
      {
        service: 'Azure DevOps',
        linkHosts: ['dev.azure.com', 'visualstudio.com'],
        organizations: ['empresa', 'empresa-labs'],
      },
    ]);
    expect(linkSourcesOf(['unknownregxx'], list)).toEqual([]);
  });
});

describe('errors', () => {
  const t = i18n.t.bind(i18n);
  it('says the design texts of a failed «Conectar» (round 24)', () => {
    const azure = { service: 'Azure DevOps', provider: 'Microsoft' };
    expect(connectErrorOf(t, new ApiError(409, 'remote_disabled', 'x'), azure)).toEqual({
      title: 'No se pudo iniciar la conexión',
      body: 'Un administrador deshabilitó Azure DevOps.',
    });
    expect(connectErrorOf(t, new ApiError(503, 'gateway_unavailable', 'x'), azure)).toEqual({
      title: 'El servicio de identidad no responde',
      body: 'Mango no pudo pedir el inicio de sesión en Microsoft. Inténtalo de nuevo en unos minutos.',
    });
    expect(connectErrorOf(t, new ApiError(429, 'rate_limited', 'x'), azure)).toEqual({
      title: 'Demasiados intentos seguidos',
      body: 'Espera un minuto y vuelve a pulsar «Conectar».',
    });
    expect(connectErrorOf(t, new Error('boom'), azure)).toEqual({
      title: 'No se pudo iniciar la conexión',
      body: 'Inténtalo de nuevo en unos segundos.',
    });
  });

  it('maps the return answers to the design results', () => {
    expect(returnResultOf(new ApiError(410, 'consent_expired', 'x'))).toBe('expired');
    expect(returnResultOf(new ApiError(403, 'consent_not_yours', 'x'))).toBe('notyours');
    expect(returnResultOf(new ApiError(400, 'consent_denied', 'x'))).toBe('denied');
    expect(returnResultOf(new ApiError(400, 'conditional_access', 'x'))).toBe('conditional');
    expect(returnResultOf(new ApiError(502, 'identity_unavailable', 'x'))).toBe('error');
    expect(returnResultOf(new ApiError(409, 'consent_ambiguous', 'x'))).toBe('error');
    expect(returnResultOf(new Error('network'))).toBe('error');
    expect(returnResultOfQuery('access_denied')).toBe('denied');
    expect(returnResultOfQuery('server_error')).toBe('error');
    expect(returnResultOfQuery(null)).toBe('error');
  });
});
