import { useEffect, useMemo } from 'react';

import type { StripLinks } from '../../components/ChatMarkdown';
import { useConnections } from './ConnectionsContext';
import { linkSourcesOf } from './model';

const NONE: readonly string[] = [];

/**
 * In a turn that asked to connect an account (design round 25): the services whose organizations
 * keep their links, from the registrations the turn read or asked for. Null otherwise. Until the
 * person's connections are read it is 'pending': no link opens, and none is marked as taken out
 * (design round 26). If they could not be read it is 'failed': the same, with a note to read them
 * again (design round 27).
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
  const failed = status === 'error';
  return useMemo(() => {
    if (!used) return null;
    if (known) return linkSourcesOf([...asked, ...read], list);
    return failed ? 'failed' : 'pending';
  }, [used, known, failed, asked, read, list]);
}
