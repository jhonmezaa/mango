import { createContext, useContext } from 'react';

import type { Connection, FinishError } from './model';

export type ConnectionsStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * How «Conectar» ended: the account was already connected (A6), or the provider opened in another
 * tab and this one waits for the return (D100).
 */
export type ConnectOutcome = 'already' | 'opening';

/** Where this tab is with a consent it asked for (D100): the card and the row show it. */
export type ConsentPhase = 'opening' | 'waiting' | 'finishing';

export interface ConnectionsValue {
  status: ConnectionsStatus;
  /** The registrations of the person's groups (`GET /api/me/connections`), empty until read. */
  list: readonly Connection[];
  /** Reads the list once (on demand: the chat only needs it when a turn used a remote). */
  ensure: () => void;
  reload: () => void;
  byRegistration: (registrationId: string) => Connection | null;
  /**
   * «Conectar»: an account already connected is said in place; otherwise the provider opens in
   * another tab and this tab waits to close the consent with its own token (D100). Rejects with
   * the API's error. Call it inside the click: the tab opens before anything is awaited.
   */
  connect: (registrationId: string) => Promise<ConnectOutcome>;
  /** The consent this tab is in the middle of, for a registration; null when none. */
  phaseOf: (registrationId: string) => ConsentPhase | null;
  /** Why this tab could not finish the last consent of a registration; null when it did not fail. */
  finishErrorOf: (registrationId: string) => FinishError | null;
  /**
   * «Desconectar» (D97): Mango deletes the person's connection; nothing changes at the provider.
   * Rejects with the API's error (`disconnect_not_confirmed` when it cannot confirm it).
   */
  disconnect: (registrationId: string) => Promise<void>;
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
  phaseOf: () => null,
  finishErrorOf: () => null,
  disconnect: () => Promise.reject(new Error('no connections provider')),
  openMine: () => undefined,
});

export function useConnections(): ConnectionsValue {
  return useContext(ConnectionsContext);
}
