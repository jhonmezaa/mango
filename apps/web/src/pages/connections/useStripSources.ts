import { useEffect, useMemo } from 'react';

import type { RemoteLinkSource } from '../../security/remoteLinks';
import { useConnections } from './ConnectionsContext';
import { linkSourcesOf } from './model';

const NONE: readonly string[] = [];

/**
 * In a turn that asked to connect an account (design round 25): the services whose organizations
 * keep their links, from the registrations the turn read or asked for. Null otherwise. Until the
 * person's connections are read the list is empty, so every link is taken out.
 */
export function useStripSources(
  asked: readonly string[],
  read: readonly string[] = NONE,
): readonly RemoteLinkSource[] | null {
  const { list, ensure } = useConnections();
  const used = asked.length > 0;
  useEffect(() => {
    if (used) ensure();
  }, [used, ensure]);
  return useMemo(
    () => (used ? linkSourcesOf([...asked, ...read], list) : null),
    [used, asked, read, list],
  );
}
