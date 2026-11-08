import type { RunKind } from '@mango/ui-sandbox/protocol';
import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../../auth/useSession';
import { openSandbox, type SandboxSession } from '../../../sandbox/sandboxHost';
import { CheckIcon, LockIcon, PlayIcon, WarnIcon } from '../../icons';
import type { TextdocKind } from './canvasApi';

/**
 * Design round 41 `CanvasPreview` (D123, D124 (4)): the code of a document runs only in the
 * second origin, in the runner of V3, through the host utility of the SPA (`sandboxHost`). Mango
 * paints, outside the frame, the label of where the content comes from (TM-UI10) and the state
 * it knows (the runner's events and the end of `run()`, which is the source of truth of the end:
 * events and answers come by different ports, without order). What runs draws itself, inside.
 * Only the code travels: never a token, a link nor an id (TM-UI4).
 */

export type PreviewState = 'init' | 'run' | 'ok' | 'error' | 'init-timeout' | 'timeout';

const RUN: Record<Exclude<TextdocKind, 'document'>, RunKind> = {
  'code/python': 'python',
  'code/react': 'react',
  'code/html': 'html',
};

const TONE: Record<PreviewState, 'run' | 'ok' | 'err'> = {
  init: 'run',
  run: 'run',
  ok: 'ok',
  error: 'err',
  'init-timeout': 'err',
  timeout: 'err',
};

const LABEL = {
  init: 'init',
  run: 'run',
  ok: 'ok',
  error: 'error',
  'init-timeout': 'initTimeout',
  timeout: 'timeout',
} as const;

const MAX_HEIGHT = 640;
const MIN_HEIGHT = 260;

function stateOfError(error: unknown, started: boolean): PreviewState {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError') return started ? 'timeout' : 'init-timeout';
  return 'error';
}

export const CanvasPreview = memo(function CanvasPreview({
  kind,
  code,
}: {
  kind: Exclude<TextdocKind, 'document'>;
  code: string;
}) {
  const { t } = useTranslation();
  const { config } = useSession();
  const origin = config.sandboxOrigin;
  const frame = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PreviewState>('init');
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [round, setRound] = useState(0);

  useEffect(() => {
    const container = frame.current;
    if (!origin || !container) return undefined;
    const controller = new AbortController();
    let session: SandboxSession | null = null;
    let started = false;
    // Read after each await: the effect may have been cleaned up meanwhile.
    const aborted = () => controller.signal.aborted;
    setState('init');
    setHeight(MIN_HEIGHT);
    openSandbox({
      origin,
      container,
      title: t('chat.canvas.preview.frameTitle'),
      signal: controller.signal,
    })
      .then(async (opened) => {
        session = opened;
        if (aborted()) {
          opened.destroy();
          return;
        }
        opened.onEvent((event) => {
          if (event.type === 'status' && event.phase === 'running') setState('run');
          if (event.type === 'height')
            setHeight(Math.min(Math.max(event.px, MIN_HEIGHT), MAX_HEIGHT));
        });
        started = true;
        setState('run');
        const result = await opened.run(
          { kind: RUN[kind], source: code },
          { signal: controller.signal },
        );
        if (!aborted()) setState(result.ok ? 'ok' : 'error');
      })
      .catch((error: unknown) => {
        if (!aborted()) setState(stateOfError(error, started));
      });
    return () => {
      controller.abort();
      session?.destroy();
    };
  }, [origin, kind, code, round, t]);

  const tone = TONE[state];
  const python = kind === 'code/python';
  const shown = state === 'ok' || state === 'error';
  return (
    <div className="cv-pv">
      <div className="cv-pv-h">
        {/* TM-UI10: painted by Mango, outside the frame, so the content cannot imitate it. */}
        <span className="cv-origin">
          <LockIcon size={11} /> {t('chat.canvas.preview.origin')}
        </span>
        <span className={`cv-pv-st is-${tone}`} role="status">
          {tone === 'run' ? (
            <span className="spinner" aria-hidden="true" />
          ) : tone === 'ok' ? (
            <CheckIcon size={11} />
          ) : (
            <WarnIcon size={11} />
          )}{' '}
          {t(`chat.canvas.preview.state.${LABEL[state]}`)}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={tone === 'run' || !origin}
          onClick={() => {
            setRound((n) => n + 1);
          }}
        >
          <PlayIcon size={11} /> {t('chat.canvas.preview.run')}
        </button>
      </div>
      <div className="cv-frame" style={{ minHeight: MIN_HEIGHT }}>
        {!origin ? (
          <div className="cv-fr-msg is-err">
            <WarnIcon size={14} />
            <div>{t('chat.canvas.preview.unavailable')}</div>
          </div>
        ) : state === 'init' ? (
          <div className="cv-fr-msg">
            <span className="spinner" aria-hidden="true" />
            <div>
              <b>
                {t(python ? 'chat.canvas.preview.initTitle' : 'chat.canvas.preview.initTitleOther')}
              </b>
              <div>
                {t(python ? 'chat.canvas.preview.initBody' : 'chat.canvas.preview.initBodyOther')}
              </div>
            </div>
          </div>
        ) : state === 'run' ? (
          <div className="cv-fr-msg">
            <span className="spinner" aria-hidden="true" />
            <div>
              <b>{t('chat.canvas.preview.runTitle')}</b>
              <div>{t('chat.canvas.preview.runBody')}</div>
            </div>
          </div>
        ) : state === 'init-timeout' ? (
          <div className="cv-fr-msg is-err">
            <WarnIcon size={14} />
            <div>
              <b>{t('chat.canvas.preview.initTimeoutTitle')}</b>
              <div>{t('chat.canvas.preview.initTimeoutBody')}</div>
            </div>
          </div>
        ) : state === 'timeout' ? (
          <div className="cv-fr-msg is-err">
            <WarnIcon size={14} />
            <div>
              <b>{t('chat.canvas.preview.timeoutTitle')}</b>
            </div>
          </div>
        ) : null}
        {/* The runner's iframe goes here; it shows what ran (its output or its traceback). */}
        <div ref={frame} className={`cv-fr-host${shown ? '' : ' is-hidden'}`} style={{ height }} />
        {state === 'error' && python ? (
          <div className="cv-fr-hint">{t('chat.canvas.preview.errorHint')}</div>
        ) : null}
      </div>
      <div className="cv-pv-f">{t('chat.canvas.preview.footer')}</div>
    </div>
  );
});
