import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { holdToken, releaseToken, tokenGeneration } from '../../auth/consentHold';
import { useAuth } from '../../auth/useAuth';
import { useSession } from '../../auth/useSession';
import { openConsentChannel, parseConsentMessage, type ConsentMessage } from './consentChannel';
import {
  ConnectionsContext,
  type ConnectOutcome,
  type ConnectionsValue,
  type ConsentPhase,
} from './ConnectionsContext';
import {
  CONSENT_TTL_MS,
  consentUrl,
  finishOutcomeOf,
  idpOf,
  type Connection,
  type FinishError,
} from './model';
import { consentNavigation, PopupBlockedError } from './navigation';

// Only opened on demand: it stays out of the main chunk.
const MyConnections = lazy(() =>
  import('./MyConnections').then((module) => ({ default: module.MyConnections })),
);

/** The consent this tab asked for and waits to close (D100), in memory only. */
interface Waiting {
  registrationId: string;
  /** The generation of the access token the consent URL was asked with (consentHold.ts). */
  generation: number;
  until: number;
}

type Phases = Readonly<Record<string, ConsentPhase>>;
type FinishErrors = Readonly<Record<string, FinishError>>;

function without<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

/**
 * The person's remote connections for the whole shell: the menu's «Mis conexiones», the chat and
 * Playground card, «Leyó {servicio}», the link dialog and the Bandeja read the same list. What a
 * person may use is decided by the API (`UseRemoteMcp`); this only shows it.
 *
 * It is also the tab's side of D100: «Conectar» opens the provider in another tab, and this tab
 * closes the consent when the return page hands it the `session_id`, with its own access token
 * (the one AgentCore Identity bound the consent to).
 */
export function ConnectionsProvider({ children }: { children: ReactNode }) {
  const { api, config } = useSession();
  const { refreshSession } = useAuth();
  const [status, setStatus] = useState<ConnectionsValue['status']>('idle');
  const [list, setList] = useState<readonly Connection[]>([]);
  // `RemoteMcpEnabled` of the installation; assumed on until the list says otherwise.
  const [enabled, setEnabled] = useState(true);
  const [open, setOpen] = useState(false);
  const [phases, setPhases] = useState<Phases>({});
  const [finishErrors, setFinishErrors] = useState<FinishErrors>({});
  const loading = useRef<Promise<void> | null>(null);
  // The list as of now, for the channel's handler (it names the service in «Listo»).
  const listRef = useRef(list);
  useEffect(() => {
    listRef.current = list;
  }, [list]);
  const waiting = useRef<Waiting | null>(null);
  const finishing = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);

  const reload = useCallback(() => {
    setStatus((current) => (current === 'ready' ? current : 'loading'));
    const run = api.call('listMyConnections').then(
      (result) => {
        setList(result.connections);
        setEnabled(result.enabled);
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

  const markConnected = useCallback(
    (registrationId: string) => {
      setList((current) =>
        current.map((item) =>
          item.registration_id === registrationId
            ? { ...item, status: 'connected', connected_at: new Date().toISOString() }
            : item,
        ),
      );
      reload();
    },
    [reload],
  );

  /** Stops waiting: the token may be renewed again. */
  const stopWaiting = useCallback((registrationId: string, error: FinishError | null) => {
    if (waiting.current?.registrationId === registrationId) waiting.current = null;
    releaseToken();
    setPhases((current) => without(current, registrationId));
    if (error) setFinishErrors((current) => ({ ...current, [registrationId]: error }));
  }, []);

  /** The return page handed over a `session_id`: close the consent if this tab asked for it. */
  const onReturn = useCallback(
    (ref: string, sessionId: string) => {
      const wait = waiting.current;
      if (!wait || finishing.current) return;
      const post = (message: ConsentMessage) => channel.current?.postMessage(message);
      post({ kind: 'claimed', ref });
      const { registrationId } = wait;
      if (Date.now() > wait.until) {
        post({ kind: 'result', ref, result: 'expired' });
        stopWaiting(registrationId, 'expired');
        return;
      }
      if (tokenGeneration() !== wait.generation) {
        // Identity would refuse another token (D100 (3)): «Pídelo de nuevo».
        post({ kind: 'result', ref, result: 'orphan' });
        stopWaiting(registrationId, 'session_changed');
        return;
      }
      finishing.current = true;
      setPhases((current) => ({ ...current, [registrationId]: 'finishing' }));
      api.call('completeConsent', { body: { session_id: sessionId } }).then(
        (done) => {
          finishing.current = false;
          const closed = done.registration_id;
          const named = listRef.current.find((item) => item.registration_id === closed);
          post({
            kind: 'result',
            ref,
            result: 'ok',
            ...(named ? { service: named.service, idp: idpOf(named) } : {}),
          });
          stopWaiting(registrationId, null);
          if (closed !== registrationId) stopWaiting(closed, null);
          markConnected(closed);
        },
        (error: unknown) => {
          finishing.current = false;
          const outcome = finishOutcomeOf(error);
          post({ kind: 'result', ref, result: outcome.ret });
          if (outcome.tab === null) {
            // Not this tab's consent: it keeps waiting for its own and shows nothing (D100 (2)).
            setPhases((current) =>
              waiting.current?.registrationId === registrationId
                ? { ...current, [registrationId]: 'waiting' }
                : current,
            );
            return;
          }
          stopWaiting(registrationId, outcome.tab);
        },
      );
    },
    [api, markConnected, stopWaiting],
  );

  /** The provider came back without a `session_id` (cancelled, refused): say it in the card. */
  const onProvider = useCallback(
    (result: 'denied' | 'error') => {
      const wait = waiting.current;
      if (!wait || finishing.current) return;
      stopWaiting(wait.registrationId, result);
    },
    [stopWaiting],
  );

  useEffect(() => {
    const opened = openConsentChannel();
    if (!opened) return;
    channel.current = opened;
    opened.onmessage = (event: MessageEvent) => {
      const message = parseConsentMessage(event.data);
      if (message?.kind === 'return') onReturn(message.ref, message.session_id);
      else if (message?.kind === 'provider') onProvider(message.result);
    };
    return () => {
      opened.close();
      if (channel.current === opened) channel.current = null;
    };
  }, [onReturn, onProvider]);

  // The consent URL lives 10 minutes: past that, nothing can close it.
  const waitingFor = Object.entries(phases).find(([, phase]) => phase === 'waiting')?.[0] ?? null;
  useEffect(() => {
    const wait = waiting.current;
    if (!waitingFor || wait?.registrationId !== waitingFor) return;
    const timer = window.setTimeout(
      () => {
        if (waiting.current === wait && !finishing.current) stopWaiting(waitingFor, 'expired');
      },
      Math.max(0, wait.until - Date.now()),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [waitingFor, stopWaiting]);

  // Leaving the shell (signing out) ends the wait.
  useEffect(
    () => () => {
      waiting.current = null;
      releaseToken();
    },
    [],
  );

  const connect = useCallback(
    async (registrationId: string): Promise<ConnectOutcome> => {
      // Inside the click, before anything is awaited: popup blockers allow it then.
      const tab = consentNavigation.open();
      const previous = waiting.current;
      if (previous) stopWaiting(previous.registrationId, null);
      setFinishErrors((current) => without(current, registrationId));
      setPhases((current) => ({ ...current, [registrationId]: 'opening' }));
      try {
        if (!tab) throw new PopupBlockedError();
        // A token with most of its hour left, kept until the return (D100 (3)).
        if (!(await refreshSession())) throw new Error('the session could not be renewed');
        holdToken(CONSENT_TTL_MS);
        const generation = tokenGeneration();
        const result = await api.call('connectMyAccount', {
          path: { reg: registrationId },
          body: {},
        });
        if (result.status === 'already_connected') {
          // A6: nothing opens; the row says so and the list is read again for «Conectado».
          tab.close();
          stopWaiting(registrationId, null);
          markConnected(registrationId);
          return 'already';
        }
        const url = consentUrl(result.authorization_url, config.region);
        if (!url) throw new Error('unexpected consent url');
        tab.go(url);
        waiting.current = { registrationId, generation, until: Date.now() + CONSENT_TTL_MS };
        setPhases((current) => ({ ...current, [registrationId]: 'waiting' }));
        return 'opening';
      } catch (error) {
        tab?.close();
        stopWaiting(registrationId, null);
        throw error;
      }
    },
    [api, config.region, markConnected, refreshSession, stopWaiting],
  );

  const phaseOf = useCallback((registrationId: string) => phases[registrationId] ?? null, [phases]);
  const finishErrorOf = useCallback(
    (registrationId: string) => finishErrors[registrationId] ?? null,
    [finishErrors],
  );

  const disconnect = useCallback(
    async (registrationId: string): Promise<void> => {
      const result = await api.call('disconnectMyAccount', {
        path: { reg: registrationId },
        body: {},
      });
      setList((current) =>
        current.map((item) =>
          item.registration_id === registrationId
            ? { ...item, status: result.status, connected_at: null }
            : item,
        ),
      );
      reload();
    },
    [api, reload],
  );

  const openMine = useCallback(() => {
    setOpen(true);
    reload();
  }, [reload]);

  const value = useMemo<ConnectionsValue>(
    () => ({
      status,
      enabled,
      list,
      ensure,
      reload,
      byRegistration,
      connect,
      phaseOf,
      finishErrorOf,
      disconnect,
      openMine,
    }),
    [
      status,
      enabled,
      list,
      ensure,
      reload,
      byRegistration,
      connect,
      phaseOf,
      finishErrorOf,
      disconnect,
      openMine,
    ],
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
