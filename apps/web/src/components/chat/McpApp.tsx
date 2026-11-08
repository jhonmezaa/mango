import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AppToolResult, DisplayMode } from '@mango/ui-sandbox/protocol';

import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import type { MessageApp } from '../../hooks/chatState';
import { useConnections } from '../../pages/connections/ConnectionsContext';
import { openSandbox, type SandboxSession } from '../../sandbox/sandboxHost';
import { CloseIcon, ExpandIcon, LockIcon, PipIcon, RefreshIcon, WarnIcon } from '../icons';

/**
 * An MCP App under the answer that called its tool (D125, design round 41 `mcp-apps.jsx`). The
 * app's HTML comes from the release's signed profile through mango-api; it is checked against
 * its hash here (TM-UI8) and drawn by the runner of the second origin, never in this origin.
 * Mango draws everything around the frame: the label of origin «app de {MCP}», its buttons and
 * the footer (TM-UI10). Each `tools/call` of the app goes to mango-api, which decides it like a
 * tool call of the model (D125 (4)); the reason of a call Mango did not make goes to the footer.
 */

type State = 'loading' | 'ready' | 'timeout' | 'connect' | 'unavailable';
type Reason = 'denied' | 'budget' | 'limit' | 'down' | 'minute';
type Mode = 'inline' | 'full' | 'pip';

const TO_MODE: Record<DisplayMode, Mode> = { inline: 'inline', fullscreen: 'full', pip: 'pip' };
const TO_DISPLAY: Record<Mode, DisplayMode> = { inline: 'inline', full: 'fullscreen', pip: 'pip' };

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function reasonOf(error: unknown): Reason | 'consent' {
  if (!(error instanceof ApiError)) return 'down';
  if (error.code === 'consent_required') return 'consent';
  if (error.code === 'budget_exceeded') return 'budget';
  if (error.code === 'app_call_limit') return 'limit';
  if (error.code === 'rate_limited') return 'minute';
  if (error.code === 'app_tool_not_allowed' || error.code === 'app_call_denied') return 'denied';
  return 'down';
}

export interface McpAppProps {
  readonly conversationId: string;
  readonly app: MessageApp;
}

export const McpApp = memo(function McpApp({ conversationId, app }: McpAppProps) {
  const { t } = useTranslation();
  const { api, config } = useSession();
  const connections = useConnections();
  const frameRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SandboxSession | null>(null);
  const [state, setState] = useState<State>('loading');
  const [mode, setMode] = useState<Mode>('inline');
  const [closed, setClosed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [service, setService] = useState('');
  const [calls, setCalls] = useState<{ used: number; limit: number } | null>(null);
  const [failure, setFailure] = useState<{ tool: string; reason: Reason } | null>(null);
  const modeRef = useRef<Mode>('inline');
  modeRef.current = mode;

  const changeMode = useCallback((next: Mode) => {
    setMode(next);
    sessionRef.current?.setAppDisplayMode(TO_DISPLAY[next]).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (closed) return undefined;
    const container = frameRef.current;
    const origin = config.sandboxOrigin;
    if (!container) return undefined;
    if (!origin) {
      setState('unavailable');
      return undefined;
    }
    const controller = new AbortController();
    const aborted = () => controller.signal.aborted;
    let session: SandboxSession | null = null;
    setState('loading');
    setFailure(null);
    const path = { conversation_id: conversationId, app_id: app.appId };
    void (async () => {
      try {
        const detail = await api.call('getMcpApp', { path }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setService(detail.service);
        setCalls({ used: detail.calls_used, limit: detail.calls_limit });
        // The HTML must be the one the signed profile pins (TM-UI8): otherwise it is not drawn.
        if ((await sha256Hex(detail.html)) !== detail.html_sha256) {
          setState('timeout');
          return;
        }
        session = await openSandbox({
          origin,
          container,
          title: t('mcpApps.origin', { service: detail.service }),
          signal: controller.signal,
        });
        sessionRef.current = session;
        await session.startApp(
          {
            html: detail.html,
            toolInput: detail.tool_input,
            toolResult: {
              content: detail.tool_result.content.map((b) => ({ type: 'text', text: b.text })),
              isError: detail.tool_result.is_error,
            },
            displayMode: TO_DISPLAY[modeRef.current],
          },
          {
            callTool: async (name, args): Promise<AppToolResult> => {
              try {
                const answer = await api.call('callMcpAppTool', {
                  path,
                  body: { name, arguments: args },
                });
                setCalls({ used: answer.calls_used, limit: answer.calls_limit });
                setFailure(null);
                return {
                  content: answer.result.content.map((b) => ({ type: 'text', text: b.text })),
                  isError: answer.result.is_error,
                };
              } catch (error) {
                const reason = reasonOf(error);
                if (reason === 'consent') {
                  setState('connect');
                  throw new Error(t('mcpApps.connectTitle', { service: detail.service }), {
                    cause: error,
                  });
                }
                setFailure({ tool: name, reason });
                throw new Error(
                  t(`mcpApps.reasons.${reason}`, {
                    service: detail.service,
                    limit: detail.calls_limit,
                  }),
                  { cause: error },
                );
              }
            },
            requestDisplayMode: (requested) => {
              const next = TO_MODE[requested];
              setMode(next);
              return TO_DISPLAY[next];
            },
          },
          { signal: controller.signal },
        );
        if (!aborted()) setState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        // A release that no longer curates the app: the tool stays a step of the turn.
        setState(error instanceof ApiError && error.status === 404 ? 'unavailable' : 'timeout');
      }
    })();
    return () => {
      controller.abort();
      sessionRef.current = null;
      session?.destroy();
    };
  }, [api, app.appId, attempt, closed, config.sandboxOrigin, conversationId, t]);

  useEffect(() => {
    if (mode !== 'full') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') changeMode('inline');
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [changeMode, mode]);

  if (state === 'unavailable') return null;

  const label = (
    <span className="cv-origin">
      <LockIcon size={11} /> {t('mcpApps.origin', { service: service || app.tool })}
    </span>
  );

  if (closed) {
    return (
      <div className="ap-closed">
        {label}
        <span className="mk-meta" style={{ flex: 1 }}>
          {t('mcpApps.closed')}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setClosed(false);
            setMode('inline');
            setAttempt((n) => n + 1);
          }}
        >
          {t('mcpApps.reopen')}
        </button>
      </div>
    );
  }

  const head = (
    <div className="ap-h">
      {label}
      <span className="mono ap-tool">{app.tool}</span>
      <span style={{ flex: 1 }} />
      {mode !== 'full' && (
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          title={t('mcpApps.fullscreen')}
          aria-label={t('mcpApps.fullscreen')}
          onClick={() => {
            changeMode('full');
          }}
        >
          <ExpandIcon size={12} />
        </button>
      )}
      {mode !== 'pip' && (
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          title={t('mcpApps.pip')}
          aria-label={t('mcpApps.pip')}
          onClick={() => {
            changeMode('pip');
          }}
        >
          <PipIcon size={13} />
        </button>
      )}
      {mode !== 'inline' && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            changeMode('inline');
          }}
        >
          {t('mcpApps.back')}
        </button>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        title={t('mcpApps.close')}
        aria-label={t('mcpApps.close')}
        onClick={() => {
          setClosed(true);
          setMode('inline');
        }}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );

  const name = service || app.tool;
  const foot =
    mode === 'pip' ? null : (
      <div className="ap-f">
        {failure ? (
          <span className="ap-f-err" role="alert">
            <WarnIcon size={11} /> {t('mcpApps.callFailedBefore')}
            <span className="mono">{failure.tool}</span>
            {t('mcpApps.callFailedAfter', {
              reason: t(`mcpApps.reasons.${failure.reason}`, {
                service: name,
                limit: calls?.limit ?? 0,
              }),
            })}
          </span>
        ) : (
          <span>
            {state === 'ready' && calls
              ? t('mcpApps.calls', { used: calls.used, limit: calls.limit })
              : ''}
            {t('mcpApps.footer')}
          </span>
        )}
      </div>
    );

  const message =
    state === 'loading' ? (
      <div className="ap-fr-msg">
        <span className="spinner" /> {t('mcpApps.loading')}
      </div>
    ) : state === 'timeout' ? (
      <div className="ap-fr-msg is-err" role="alert">
        <WarnIcon size={14} />
        <span style={{ flex: 1 }}>{t('mcpApps.timeout')}</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setAttempt((n) => n + 1);
          }}
        >
          <RefreshIcon size={11} /> {t('mcpApps.retry')}
        </button>
      </div>
    ) : state === 'connect' ? (
      <div className="ap-connect">
        <LockIcon size={16} />
        <div style={{ flex: 1 }}>
          <b>{t('mcpApps.connectTitle', { service: name })}</b>
          <div className="mk-meta">{t('mcpApps.connectBody')}</div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            connections.connect(app.registrationId).then(
              () => {
                setAttempt((n) => n + 1);
              },
              () => undefined,
            );
          }}
        >
          {t('mcpApps.connect')}
        </button>
      </div>
    ) : null;

  // One card whose wrapper changes with the mode, so the frame (and the app in it) is never
  // moved in the DOM: moving an iframe reloads it.
  const wrapper = mode === 'full' ? 'ap-full' : mode === 'pip' ? 'ap-pip' : '';
  const card = `ap-card${mode === 'full' ? ' is-full' : mode === 'pip' ? ' is-pip' : ''}`;
  const live = state === 'ready' || state === 'loading';
  return (
    <>
      {mode !== 'inline' && (
        <div className="ap-away">
          <PipIcon size={13} />
          <span style={{ flex: 1 }}>
            {mode === 'full' ? t('mcpApps.awayFull') : t('mcpApps.awayPip')}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              changeMode('inline');
            }}
          >
            {t('mcpApps.bringBack')}
          </button>
        </div>
      )}
      <div
        className={wrapper}
        {...(mode === 'inline'
          ? {}
          : {
              role: 'dialog',
              'aria-modal': mode === 'full',
              'aria-label': t('mcpApps.origin', { service: name }),
            })}
      >
        <div className={card}>
          {head}
          {message}
          <div
            ref={frameRef}
            className={`ap-frame${live && state !== 'loading' ? '' : ' is-hidden'}`}
          />
          {state !== 'connect' && state !== 'timeout' && foot}
        </div>
      </div>
    </>
  );
});
