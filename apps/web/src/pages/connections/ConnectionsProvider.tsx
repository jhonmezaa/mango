import { lazy, Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';

import { useSession } from '../../auth/useSession';
import {
  ConnectionsContext,
  type ConnectOutcome,
  type ConnectionsValue,
} from './ConnectionsContext';
import { consentUrl, type Connection } from './model';
import { consentNavigation } from './navigation';

// Only opened on demand: it stays out of the main chunk.
const MyConnections = lazy(() =>
  import('./MyConnections').then((module) => ({ default: module.MyConnections })),
);

/**
 * The person's remote connections for the whole shell: the menu's «Mis conexiones», the chat and
 * Playground card, «Leyó {servicio}», the link dialog and the Bandeja read the same list. What a
 * person may use is decided by the API (`UseRemoteMcp`); this only shows it.
 */
export function ConnectionsProvider({ children }: { children: ReactNode }) {
  const { api, config } = useSession();
  const [status, setStatus] = useState<ConnectionsValue['status']>('idle');
  const [list, setList] = useState<readonly Connection[]>([]);
  const [open, setOpen] = useState(false);
  const loading = useRef<Promise<void> | null>(null);

  const reload = useCallback(() => {
    setStatus((current) => (current === 'ready' ? current : 'loading'));
    const run = api.call('listMyConnections').then(
      (result) => {
        setList(result.connections);
        setStatus('ready');
      },
      () => {
        setStatus('error');
      },
    );
    loading.current = run;
  }, [api]);

  const ensure = useCallback(() => {
    if (loading.current === null) reload();
  }, [reload]);

  const byRegistration = useCallback(
    (registrationId: string) =>
      list.find((item) => item.registration_id === registrationId) ?? null,
    [list],
  );

  const connect = useCallback(
    async (registrationId: string): Promise<ConnectOutcome> => {
      const result = await api.call('connectMyAccount', {
        path: { reg: registrationId },
        body: {},
      });
      if (result.status === 'already_connected') {
        // A6: nothing opens; the row says so and the list is read again for «Conectado».
        setList((current) =>
          current.map((item) =>
            item.registration_id === registrationId
              ? { ...item, status: 'connected', connected_at: new Date().toISOString() }
              : item,
          ),
        );
        reload();
        return 'already';
      }
      const url = consentUrl(result.authorization_url, config.region);
      if (!url) throw new Error('unexpected consent url');
      consentNavigation.go(url);
      return 'opening';
    },
    [api, config.region, reload],
  );

  const openMine = useCallback(() => {
    setOpen(true);
    reload();
  }, [reload]);

  const value = useMemo<ConnectionsValue>(
    () => ({ status, list, ensure, reload, byRegistration, connect, openMine }),
    [status, list, ensure, reload, byRegistration, connect, openMine],
  );

  return (
    <ConnectionsContext.Provider value={value}>
      {children}
      {open && (
        <Suspense fallback={null}>
          <MyConnections
            onClose={() => {
              setOpen(false);
            }}
          />
        </Suspense>
      )}
    </ConnectionsContext.Provider>
  );
}
