import { describe, expect, it } from 'vitest';

import { remoteInboxItems } from './inboxItems';
import {
  dayInput,
  daysUntil,
  formErrors,
  formatDay,
  headlineOf,
  historyOf,
  initialsOf,
  parseRemotePath,
  pendingRows,
  remotePath,
  rowsOf,
  settingsRows,
  statusOf,
  type RemoteForm,
} from './model';
import {
  CHANGE,
  CHANGE_2,
  ME,
  PROFILE,
  REG_ID,
  REG_ID_2,
  inDays,
  pendingRegistration,
  registration,
  remoteCatalog,
  request,
} from './testFixtures';

const FORM: RemoteForm = {
  kind: 'enable',
  organization: 'contoso',
  tenantId: '00000000-0000-4000-8000-000000000001',
  clientId: '00000000-0000-4000-8000-000000000002',
  secret: 's3cr3t',
  secretExpiresOn: inDays(90),
  toolsets: ['wit'],
  groups: ['finops-central'],
};

describe('statusOf', () => {
  it('draws the statuses of the API as the design does', () => {
    expect(statusOf(registration({ status: 'approved' }))).toBe('creating');
    expect(statusOf(registration({ status: 'disabling' }))).toBe('creating');
    expect(statusOf(registration({ status: 'failed' }))).toBe('failed');
    expect(statusOf(registration({ status: 'active', secret_level: 'd7' }))).toBe('active');
    expect(statusOf(registration({ status: 'active', secret_level: 'expired' }))).toBe(
      'secretExpired',
    );
  });
});

describe('rowsOf', () => {
  it('is one row for a registration asked for the first time', () => {
    const rows = rowsOf(remoteCatalog([pendingRegistration()]), PROFILE.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: REG_ID, status: 'pending' });
    expect(rows[0]?.request?.id).toBe(CHANGE);
  });

  it('adds a row for a change of tenant or app on a live registration', () => {
    const rows = rowsOf(
      remoteCatalog([registration({ pending: request({ kind: 'replace_app' }) })]),
      PROFILE.id,
    );
    expect(rows.map((row) => [row.key, row.status])).toEqual([
      [REG_ID, 'active'],
      [`${REG_ID}:${CHANGE}`, 'pending'],
    ]);
    expect(rows[0]?.request).toBeNull();
  });

  it('shows a request to change the groups as its own row (round 24)', () => {
    const catalog = remoteCatalog([registration({ pending: request({ kind: 'params' }) })]);
    expect(rowsOf(catalog, PROFILE.id)).toHaveLength(2);
    expect(pendingRows(catalog)).toHaveLength(1);
  });
});

describe('headlineOf, historyOf and settingsRows', () => {
  it('speaks for the profile with the live registration first', () => {
    const catalog = remoteCatalog([
      pendingRegistration(),
      registration({ id: REG_ID_2, status: 'disabled' }),
      registration({ id: 'zzzzzzzzzzzz', status: 'active' }),
    ]);
    expect(headlineOf(rowsOf(catalog, PROFILE.id))?.registration.id).toBe('zzzzzzzzzzzz');
    expect(settingsRows(catalog).map((row) => row.registration.id)).toEqual([
      REG_ID_2,
      'zzzzzzzzzzzz',
    ]);
  });

  it('keeps rejected and withdrawn requests, the most recent first', () => {
    const catalog = remoteCatalog([
      registration({
        history: [
          request({ status: 'approved', decided_at: '2026-10-03T00:00:00Z' }),
          request({ id: CHANGE_2, status: 'withdrawn', decided_at: '2026-10-01T00:00:00Z' }),
          request({ status: 'rejected', decided_at: '2026-10-02T00:00:00Z' }),
          request({ status: 'cancelled' }),
        ],
      }),
    ]);
    expect(historyOf(catalog, PROFILE.id).map(({ request: item }) => item.status)).toEqual([
      'rejected',
      'withdrawn',
    ]);
  });
});

describe('formErrors', () => {
  it('accepts a complete request', () => {
    expect(formErrors(FORM)).toEqual({});
  });

  it('asks for the name of the organization, never a URL', () => {
    expect(formErrors({ ...FORM, organization: '' }).organization).toBe('organizationRequired');
    expect(formErrors({ ...FORM, organization: 'dev.azure.com/contoso' }).organization).toBe(
      'organizationUrl',
    );
    expect(formErrors({ ...FORM, organization: '-bad' }).organization).toBe('organizationPattern');
    expect(formErrors({ ...FORM, organization: 'a'.repeat(50) }).organization).toBe(
      'organizationPattern',
    );
  });

  it('checks GUIDs, the secret, the expiry, toolsets and groups', () => {
    const errors = formErrors({
      ...FORM,
      tenantId: 'contoso.onmicrosoft.com',
      clientId: '',
      secret: '   ',
      secretExpiresOn: inDays(0),
      toolsets: [],
      groups: [],
    });
    expect(errors).toEqual({
      tenantId: 'guid',
      clientId: 'guid',
      secret: 'secretRequired',
      secretExpiresOn: 'expiryFuture',
      toolsets: 'toolsetsRequired',
      groups: 'groupsRequired',
    });
    expect(formErrors({ ...FORM, secretExpiresOn: inDays(731) }).secretExpiresOn).toBe(
      'expiryTooFar',
    );
    expect(formErrors({ ...FORM, secret: 'x'.repeat(513) }).secret).toBe('secretTooLong');
  });

  it('does not ask again for what a change of app keeps', () => {
    expect(
      formErrors({ ...FORM, kind: 'replace_app', organization: '', toolsets: [], groups: [] }),
    ).toEqual({});
  });
});

describe('routes', () => {
  it('reads only well-formed ids from the path', () => {
    expect(parseRemotePath('')).toBeNull();
    expect(parseRemotePath('remote')).toEqual({ profile: null, row: null });
    expect(parseRemotePath('remote/Azure DevOps')).toEqual({ profile: null, row: null });
    expect(parseRemotePath(`remote/azure-devops/${REG_ID}`)).toEqual({
      profile: 'azure-devops',
      row: REG_ID,
    });
    expect(parseRemotePath(`remote/azure-devops/${REG_ID}/${CHANGE}`)).toEqual({
      profile: 'azure-devops',
      row: `${REG_ID}:${CHANGE}`,
    });
    expect(parseRemotePath('remote/azure-devops/javascript:alert(1)')).toEqual({
      profile: 'azure-devops',
      row: null,
    });
  });

  it('builds the path of a row back', () => {
    const catalog = remoteCatalog([registration({ pending: request({ kind: 'replace_app' }) })]);
    const [live, change] = rowsOf(catalog, PROFILE.id);
    expect(remotePath()).toBe('/mcp/remote');
    expect(remotePath(PROFILE.id, live)).toBe(`/mcp/remote/azure-devops/${REG_ID}`);
    expect(remotePath(PROFILE.id, change)).toBe(`/mcp/remote/azure-devops/${REG_ID}/${CHANGE}`);
  });
});

describe('dates and tiles', () => {
  it('counts whole local days', () => {
    expect(daysUntil(inDays(5))).toBe(5);
    expect(daysUntil(dayInput(-2))).toBe(-2);
    expect(daysUntil('mañana')).toBeNull();
    expect(formatDay('nope')).toBe('nope');
  });

  it('draws the initials of the service', () => {
    expect(initialsOf('Azure DevOps')).toBe('AD');
    expect(initialsOf('jira')).toBe('JI');
  });
});

describe('remoteInboxItems', () => {
  it('lists the requests of other administrators only', () => {
    const catalog = remoteCatalog([
      pendingRegistration(),
      registration({
        id: REG_ID_2,
        pending: request({ id: CHANGE_2, own: true, requested_by: ME }),
      }),
    ]);
    expect(remoteInboxItems(catalog).map((item) => item.key)).toEqual([`remote:${CHANGE}`]);
  });
});
