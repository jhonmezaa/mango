import { useEffect, useMemo } from 'react';

import type { StripLinks } from '../../components/ChatMarkdown';
import { useConnections } from './ConnectionsContext';
import { linkSourcesOf } from './model';

const NONE: readonly string[] = [];

/**
 * In a turn that asked to connect an account (design round 25): the services whose organizations
 * keep their links, from the registrations the turn read or asked for. Null otherwise. Until the
 * person's connections are read it is 'pending': no link opens, and none is marked as taken out
 * (design round 26).
 */
export function useStripSources(
  asked: readonly string[],
  read: readonly string[] = NONE,
): StripLinks {
  const { status, list, ensure } = useConnections();
  const used = asked.length > 0;
  useEffect(() => {
    if (used) ensure();
  }, [used, ensure]);
  const known = status === 'ready';
  return useMemo(
    () => (!used ? null : known ? linkSourcesOf([...asked, ...read], list) : 'pending'),
    [used, known, asked, read, list],
  );
}
