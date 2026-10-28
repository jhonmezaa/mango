import { describe, expect, it } from 'vitest';

import i18n from 'i18next';

import '../../i18n';
import { bodyOf, remoteNoticeOf, shownKind, titleOf, type InboxItem } from './model';

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
    expect(remoteNoticeOf(item, () => 'Azure DevOps', true)).toEqual({
      kind: 'connect',
      service: 'Azure DevOps',
    });
    // Read, and not among them: design `remoteGone`. Not read yet: nothing to say.
    expect(remoteNoticeOf(item, () => null, true)).toEqual({ kind: 'gone' });
    expect(remoteNoticeOf(item, () => null, false)).toBeNull();
    expect(remoteNoticeOf({ ...item, kind: 'run' }, () => 'Azure DevOps', true)).toBeNull();
  });

  it('says what to connect, as text', () => {
    const remote = { kind: 'connect', service: 'Azure DevOps' } as const;
    expect(titleOf(t, item, remote)).toBe('Conecta tu cuenta de Azure DevOps');
    expect(bodyOf(t, item, remote)).toBe(
      'La tarea "Resumen semanal del sprint" no pudo leer Azure DevOps porque no has conectado tu cuenta.',
    );
    // Connections not read yet: the failed run it also is.
    expect(titleOf(t, item)).toBe('Resumen semanal del sprint · no se completó');
  });

  it('says a service is gone without naming it (design remoteGone)', () => {
    const gone = { kind: 'gone' } as const;
    expect(titleOf(t, item, gone)).toBe('Tu tarea no pudo leer un servicio externo');
    expect(bodyOf(t, item, gone)).toBe(
      'La tarea "Resumen semanal del sprint" usa un servicio externo que ya no está en tus conexiones: lo deshabilitaron o ya no es de tus grupos. Va a fallar mientras el agente use sus tools.',
    );
  });
});
