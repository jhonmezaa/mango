import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';

/** Same limit as the API (`MAX_IDS_PER_CALL`). */
const IDS_PER_CALL = 50;

/** Design admin.jsx `userErr`: what the «Personas» field accepts as an email. */
const EMAIL_PATTERN = /^[^\s@"\\]+@[^\s@"\\]+\.[a-z]{2,}$/i;
/** Same limit as the API (`MAX_EMAIL_LENGTH`). */
const EMAIL_MAX = 254;

export function isEmail(value: string): boolean {
  return value.length <= EMAIL_MAX && EMAIL_PATTERN.test(value);
}

export type LookupResult =
  | { kind: 'found'; id: string }
  | { kind: 'not_found' }
  | { kind: 'rate_limited' }
  | { kind: 'failed' };

export interface People {
  /** Email of a user identifier, when the directory gave one. Text from the API. */
  emailOf: (id: string) => string | undefined;
  /** Looks one person up by email (POST /api/directory/users/resolve). */
  lookup: (email: string) => Promise<LookupResult>;
}

/**
 * Emails of the people an agent version is shared with. The API stores user identifiers; whoever
 * may create agents (creators and administrators) resolves them through the directory endpoint,
 * which authorizes, rate-limits and audits every call. `enabled` only avoids a request the
 * server would refuse: without emails the identifiers are shown, as before.
 */
export function usePeople(api: ApiClient, ids: readonly string[], enabled: boolean): People {
  const [emails, setEmails] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Identifiers already asked for (answered or not): a failure is not retried in a loop.
  const asked = useRef(new Set<string>());
  // A primitive dependency: the effect runs when the set of ids changes, not on every render.
  const key = [...ids].sort().join(' ');

  useEffect(() => {
    if (!enabled) return;
    const pending = key.split(' ').filter((id) => id !== '' && !asked.current.has(id));
    if (pending.length === 0) return;
    for (const id of pending) asked.current.add(id);
    const chunks: string[][] = [];
    for (let start = 0; start < pending.length; start += IDS_PER_CALL) {
      chunks.push(pending.slice(start, start + IDS_PER_CALL));
    }
    // Not cancelled when the ids change: these were asked for once and the answer still counts.
    Promise.all(chunks.map((chunk) => api.call('resolveUsers', { body: { ids: chunk } }))).then(
      (answers) => {
        setEmails((current) => {
          const next = new Map(current);
          for (const answer of answers)
            for (const user of answer.users) next.set(user.id, user.email);
          return next;
        });
      },
      () => {
        // Emails are a convenience: without them the identifiers stay on screen.
      },
    );
  }, [api, key, enabled]);

  const lookup = useCallback(
    async (email: string): Promise<LookupResult> => {
      try {
        const answer = await api.call('resolveUsers', { body: { emails: [email] } });
        const user = answer.users[0];
        if (!user) return { kind: 'not_found' };
        asked.current.add(user.id);
        setEmails((current) => new Map(current).set(user.id, user.email));
        return { kind: 'found', id: user.id };
      } catch (error) {
        if (error instanceof ApiError && error.status === 429) return { kind: 'rate_limited' };
        return { kind: 'failed' };
      }
    },
    [api],
  );

  const emailOf = useCallback((id: string) => emails.get(id), [emails]);
  return { emailOf, lookup };
}
