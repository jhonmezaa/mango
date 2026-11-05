import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { usd } from '../../components/admin/govFormat';
import { ArrowRightIcon, CloseIcon, CopyIcon, LockIcon, X2Icon } from '../../components/icons';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { dateText, formatMs, intText, kindOf, shortId, spanBar, whoOf, type Trace } from './model';

interface Props {
  trace: Trace;
  agentName: string;
  onClose: () => void;
  onCopy: (id: string) => void;
  onActivity: () => void;
}

/**
 * «Traza {id corto}» (design round 37 `TraceDetail`): metadata only, never content. «Copiar ID»
 * copies the whole id. The model and tool names come from spans the harness wrote: text only.
 */
export function TraceDrawer({ trace, agentName, onClose, onCopy, onActivity }: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const ref = useFocusTrap<HTMLElement>(true, onClose);
  const [open, setOpen] = useState<number | null>(null);
  const kind = kindOf(trace);
  const who = t(`observability.row.${kind}`, { who: whoOf(trace) });
  const failed = trace.status === 'error';

  return createPortal(
    <div
      className="mk-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={ref}
        className="mk-drawer ob-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="mk-drawer-h">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="ob-drawer-t">
              {t('observability.drawer.title')} <span className="mono">{shortId(trace.id)}</span>
            </h2>
            <div className="mk-meta ob-drawer-s">
              {who} · {agentName}
              {trace.model ? (
                <>
                  {' · '}
                  <span className="mono">{trace.model}</span>
                </>
              ) : null}{' '}
              · {dateText(trace.started_at)}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t('observability.drawer.copy')}
            title={t('observability.drawer.copy')}
            onClick={() => {
              onCopy(trace.id);
            }}
          >
            <CopyIcon size={13} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="mk-drawer-b">
          <div className="mc-alert">
            <LockIcon size={14} />
            <div>{t('observability.drawer.notice')}</div>
          </div>
          <div className="ob-sum">
            <div>
              <span>{t('observability.drawer.duration')}</span>
              <b className="mono">{formatMs(trace.duration_ms)}</b>
            </div>
            <div>
              <span>{t('observability.drawer.tokens')}</span>
              <b className="mono">
                {trace.input_tokens === null ? '—' : intText(trace.input_tokens)} /{' '}
                {trace.output_tokens === null ? '—' : String(trace.output_tokens)}
              </b>
            </div>
            <div>
              <span>{t('observability.drawer.cost')}</span>
              <b className="mono">{trace.cost_usd === null ? '—' : usd(trace.cost_usd)}</b>
            </div>
            <div>
              <span>{t('observability.drawer.spans')}</span>
              <b className="mono">{trace.spans.length + trace.more_spans}</b>
            </div>
          </div>
          {failed ? (
            <div className="mc-alert red">
              <X2Icon size={14} />
              <div>{t('observability.drawer.toolError')}</div>
            </div>
          ) : null}
          <section className="mk-sec">
            <h3 className="mk-sec-t">{t('observability.drawer.waterfall')}</h3>
            <div className="ob-wf">
              {trace.spans.map((span, index) => {
                const tone = span.kind === 'model' ? 'model' : span.failed ? 'error' : 'ok';
                const isOpen = open === index;
                const bar = spanBar(span, trace.duration_ms);
                const name =
                  span.kind === 'model'
                    ? span.name
                      ? t('observability.drawer.model', { model: span.name })
                      : t('observability.drawer.modelUnknown')
                    : (span.name ?? t('observability.drawer.toolUnknown'));
                return (
                  // The spans have no id of their own; their order in the trace is stable.
                  <div key={index} className="ob-span-w">
                    <button
                      type="button"
                      className="ob-span"
                      aria-expanded={isOpen}
                      onClick={() => {
                        setOpen(isOpen ? null : index);
                      }}
                    >
                      <span className="ob-span-n">
                        <span className={`tk-dot ob-tone-${tone}`} />
                        <span
                          className={span.kind === 'tool' ? 'mono ob-span-tool' : 'ob-span-model'}
                        >
                          {name}
                        </span>
                      </span>
                      <span className="ob-span-bar">
                        <span
                          className={`ob-tone-${tone}`}
                          style={{ left: `${String(bar.left)}%`, width: `${String(bar.width)}%` }}
                        />
                      </span>
                      <span className="mono mk-meta ob-span-ms">{formatMs(span.duration_ms)}</span>
                    </button>
                    {isOpen ? (
                      <div className="ob-span-d">
                        {span.kind === 'model' ? (
                          <>
                            {t('observability.drawer.inputTokens')}{' '}
                            <b className="mono">{span.input_tokens ?? '—'}</b> ·{' '}
                            {t('observability.drawer.outputTokens')}{' '}
                            <b className="mono">{span.output_tokens ?? '—'}</b>
                          </>
                        ) : span.failed ? (
                          t('observability.drawer.spanError')
                        ) : (
                          t('observability.drawer.spanOk')
                        )}
                        {t('observability.drawer.startsAt', { at: formatMs(span.offset_ms) })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {trace.more_spans > 0 ? (
              <div className="mk-meta ob-more-spans">
                {t('observability.drawer.moreSpans', { count: trace.more_spans })}
              </div>
            ) : null}
            <div className="mk-meta ob-legend">
              <i className="ob-lg ob-tone-model" /> {t('observability.drawer.legend.model')}{' '}
              <i className="ob-lg ob-tone-ok" /> {t('observability.drawer.legend.tool')}{' '}
              <i className="ob-lg ob-tone-error" /> {t('observability.drawer.legend.error')}
            </div>
          </section>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-sm" onClick={onActivity}>
              {t('observability.drawer.activity')} <ArrowRightIcon size={11} />
            </button>
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
