import { useEffect, useState } from 'react';

import type { ApiClient } from '../../api/client';
import { pendingRows, type RemoteCatalog, type RemoteProfile, type Row } from './model';

/**
 * Bandeja (design `RM.inboxItems`): an administrator gets the requests of another one to approve
 * on top. The web composes them from GET /api/mcp/remotes (owner's choice, 2026-10-27): they have
 * no read or archived state on the server and leave the Bandeja once someone decides them.
 */
export interface RemoteInboxItem {
  key: string;
  row: Row;
  profile: RemoteProfile;
}

export const REMOTE_KEY_PREFIX = 'remote:';

export function remoteInboxItems(catalog: RemoteCatalog): RemoteInboxItem[] {
  return pendingRows(catalog).flatMap((row) => {
    const profile = catalog.profiles.find((item) => item.id === row.registration.profile_id);
    // Who asked does not approve (D46): their own request is not something to sign.
    if (!profile || !row.request || row.request.own) return [];
    return [{ key: `${REMOTE_KEY_PREFIX}${row.request.id}`, row, profile }];
  });
}

/** Only for administrators: nobody else can approve, and the API gives them no requests. */
export function useRemoteInbox(api: ApiClient, isAdmin: boolean): RemoteInboxItem[] {
  const [items, setItems] = useState<RemoteInboxItem[]>([]);
  useEffect(() => {
    if (!isAdmin) return;
    const controller = new AbortController();
    api.call('getRemoteCatalog', {}, { signal: controller.signal }).then(
      (catalog) => {
        setItems(remoteInboxItems(catalog));
      },
      // The Bandeja works without them: the requests are also in the catalog.
      () => undefined,
    );
    return () => {
      controller.abort();
    };
  }, [api, isAdmin]);
  return items;
}
