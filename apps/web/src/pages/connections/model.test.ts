import i18n from 'i18next';
import { describe, expect, it } from 'vitest';

import '../../i18n';
import { ApiError } from '../../api/errors';
import {
  connectErrorOf,
  consentUrl,
  idpsOf,
  linkSourcesOf,
  finishOutcomeOf,
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
    expect(rowStateOf(connection(), null)).toBe('none');
    expect(rowStateOf(connection(), 'opening')).toBe('opening');
    expect(rowStateOf(connection(), 'waiting')).toBe('waiting');
    expect(rowStateOf(connection(), 'finishing')).toBe('finishing');
    expect(rowStateOf(connection({ status: 'connected' }), null)).toBe('on');
    expect(rowStateOf(connection({ status: 'secret_expired' }), null)).toBe('blocked');
    expect(
      rowStateOf(
        connection({ status: 'secret_expired', connected_at: '2026-10-01T00:00:00Z' }),
        null,
      ),
    ).toBe('onBlocked');
    expect(rowStateOf(connection({ status: 'disabled' }), 'waiting')).toBe('off');
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

  it('maps the callback answers for the waiting tab and the return page (D100)', () => {
    const of = (code: string) => finishOutcomeOf(new ApiError(400, code, 'x'));
    expect(of('consent_expired')).toEqual({ tab: 'expired', ret: 'expired' });
    // Not this tab's consent: it stays silent.
    expect(of('consent_not_yours')).toEqual({ tab: null, ret: 'notyours' });
    expect(of('consent_denied')).toEqual({ tab: 'denied', ret: 'denied' });
    expect(of('conditional_access')).toEqual({ tab: 'conditional', ret: 'conditional' });
    expect(of('consent_ambiguous')).toEqual({ tab: 'error', ret: 'ambiguous' });
    expect(of('identity_unavailable')).toEqual({ tab: 'error', ret: 'error' });
    expect(finishOutcomeOf(new Error('network'))).toEqual({ tab: 'error', ret: 'error' });
    expect(returnResultOfQuery('access_denied')).toBe('denied');
    expect(returnResultOfQuery('server_error')).toBe('error');
    expect(returnResultOfQuery(null)).toBe('error');
  });
});
