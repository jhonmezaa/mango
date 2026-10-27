import { describe, expect, it } from 'vitest';

import { shownKind } from './model';

describe('shownKind', () => {
  it('shows a run that needs a remote connection as the run notice it is (D98 (20))', () => {
    expect(shownKind({ kind: 'remote_connect' })).toBe('run');
    for (const kind of ['run', 'approval', 'kbsource'] as const) {
      expect(shownKind({ kind })).toBe(kind);
    }
  });
});
