import { createContext, useContext } from 'react';

import type { Connection } from './model';

export type ConnectionsStatus = 'idle' | 'loading' | 'ready' | 'error';

/** «Conectar» ended without leaving the page: the account was already connected (A6). */
export type ConnectOutcome = 'already' | 'opening';

export interface ConnectionsValue {
  status: ConnectionsStatus;
  /** The registrations of the person's groups (`GET /api/me/connections`), empty until read. */
  list: readonly Connection[];
  /** Reads the list once (on demand: the chat only needs it when a turn used a remote). */
  ensure: () => void;
  reload: () => void;
  byRegistration: (registrationId: string) => Connection | null;
  /**
   * «Conectar»: an account already connected is said in place; otherwise the page leaves for the
   * provider in this same tab. Rejects with the API's error.
   */
  connect: (registrationId: string) => Promise<ConnectOutcome>;
  /** Opens «Mis conexiones» (design: the person's menu and the chat card). */
  openMine: () => void;
}

export const ConnectionsContext = createContext<ConnectionsValue>({
  status: 'idle',
  list: [],
  ensure: () => undefined,
  reload: () => undefined,
  byRegistration: () => null,
  connect: () => Promise.reject(new Error('no connections provider')),
  openMine: () => undefined,
});

export function useConnections(): ConnectionsValue {
  return useContext(ConnectionsContext);
}
