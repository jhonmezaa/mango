import { describe, expect, it } from 'vitest';

import i18n from 'i18next';

import '../../i18n';
import { bodyOf, remoteServiceOf, shownKind, titleOf, type InboxItem } from './model';

describe('shownKind', () => {
  it('shows a run that needs a remote connection as the run notice it is (D98 (20))', () => {
    expect(shownKind({ kind: 'remote_connect' })).toBe('run');
    for (const kind of ['run', 'approval', 'kbsource'] as const) {
      expect(shownKind({ kind })).toBe(kind);
    }
  });
});

describe('remote_connect notices (design remoteTask)', () => {
  const item = {
    kind: 'remote_connect',
    item_id: '1761600000000abcdef0123456789',
    agent_id: 'finops',
    agent_name: 'FinOps',
    at: '2026-10-27T12:00:00Z',
    read: false,
    archived: false,
    approval: null,
    run: {
      task_id: 'a'.repeat(32),
      run_id: 'b'.repeat(32),
      task_name: 'Resumen semanal del sprint',
      ok: false,
      reason: 'remote_consent_required',
      summary: null,
    },
    remote: { registration_id: 'abcdefghij23' },
  } as InboxItem;
  const t = i18n.t.bind(i18n);

  it("names the service only when the registration is among the person's", () => {
    expect(remoteServiceOf(item, () => 'Azure DevOps')).toBe('Azure DevOps');
    expect(remoteServiceOf(item, () => null)).toBeNull();
    expect(remoteServiceOf({ ...item, kind: 'run' }, () => 'Azure DevOps')).toBeNull();
  });

  it('says what to connect, as text', () => {
    expect(titleOf(t, item, 'Azure DevOps')).toBe('Conecta tu cuenta de Azure DevOps');
    expect(bodyOf(t, item, 'Azure DevOps')).toBe(
      'La tarea "Resumen semanal del sprint" no pudo leer Azure DevOps porque no has conectado tu cuenta.',
    );
    // Unknown registration: the failed run it also is.
    expect(titleOf(t, item)).toBe('Resumen semanal del sprint · no se completó');
  });
});
