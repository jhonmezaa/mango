import { lazy, memo, Suspense, useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { CodeFile } from '../../api/codeSchemas';
import { copyText } from '../../lib/clipboard';
import {
  BarChartIcon,
  CopyIcon,
  InfoIcon,
  LockIcon,
  RefreshIcon,
  TableIcon,
  WarnIcon,
} from '../icons';
import {
  chartTsv,
  formatCell,
  formatValue,
  parseChartBlock,
  xLabelOf,
  type ChartSpec,
} from './chartSpec';
import { useChatFilesScope, useChatOutput, useFileView } from './chatFiles';
import { FileCard } from './FileCard';

// The drawing loads only when an answer has a chart (D118 (3)).
const ChartView = lazy(() => import('./ChartView'));

/** Design round 41: «Ver datos» shows at most this many rows; «Copiar datos» copies them all. */
export const DATA_SHOWN_ROWS = 200;

/** Design round 41 `head`: the title, its subtitle and the card's actions. */
function Head({ spec, actions }: { spec: ChartSpec; actions?: ReactNode }) {
  const title = spec.meta.title;
  if (!title && !actions) return null;
  return (
    <div className="cr-chart-h">
      <div className="min-w-0">
        {title ? <div className="cr-chart-t">{title}</div> : null}
        {spec.meta.subtitle ? <div className="cr-chart-s">{spec.meta.subtitle}</div> : null}
      </div>
      {actions}
    </div>
  );
}

function Loading() {
  const { t } = useTranslation();
  return (
    <div className="cr-chart-load" role="status" aria-label={t('chat.chart.loadingLabel')}>
      <span className="spinner" aria-hidden="true" /> {t('chat.chart.loading')}
    </div>
  );
}

/** Design round 40: «No se pudo dibujar esta gráfica. Los datos que mandó el agente…». */
export function InvalidChart() {
  const { t } = useTranslation();
  return (
    <div className="cr-chart">
      <div className="mc-alert" role="status">
        <InfoIcon size={14} />
        <div>
          <b>{t('chat.chart.invalidTitle')}</b> {t('chat.chart.invalid')}
        </div>
      </div>
    </div>
  );
}

/**
 * Design round 41 «Ver datos»: the same data as a table, the hidden series too (a pie: value and
 * share of the total). A fixed header, 300 px of scroll and at most 200 rows.
 */
function DataView({ spec }: { spec: ChartSpec }) {
  const { t } = useTranslation();
  const pie = spec.chartType === 'pie';
  const scatter = spec.chartType === 'scatter';
  const [first] = spec.series;
  const key = first?.key ?? '';
  const total = pie
    ? spec.data.reduce((sum, row) => {
        const v = row[key];
        return sum + (typeof v === 'number' ? Math.max(0, v) : 0);
      }, 0)
    : 0;
  const columns = pie
    ? [first?.label ?? key, t('chat.chart.totalShare')]
    : scatter && spec.series.length === 1
      ? [spec.axes.y.label ?? first?.label ?? key]
      : spec.series.map((s) => s.label);
  const shown = spec.data.slice(0, DATA_SHOWN_ROWS);
  const number = new Intl.NumberFormat();
  const share = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const title = spec.meta.title;
  return (
    <>
      <div
        className="cr-dt"
        tabIndex={0}
        role="region"
        aria-label={title ? t('chat.chart.dataOf', { title }) : t('chat.chart.dataUntitled')}
      >
        <table>
          <caption className="sr-only">
            {title ?? t('chat.chart.dataUntitled')}
            {spec.meta.subtitle ? ` · ${spec.meta.subtitle}` : ''}
          </caption>
          <thead>
            <tr>
              <th scope="col">{xLabelOf(spec)}</th>
              {columns.map((c, j) => (
                <th key={j} scope="col" className="num">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i}>
                <th scope="row" className={scatter ? 'mono' : undefined}>
                  {scatter ? formatCell(row[spec.xKey]) : formatValue(row[spec.xKey], 'raw')}
                </th>
                {pie && first ? (
                  <>
                    <td className="num mono">
                      {formatValue(row[key], first.valueFormat, first, spec.currency)}
                    </td>
                    <td className="num mono">
                      {typeof row[key] === 'number' && total > 0
                        ? `${share.format(Math.round((Math.max(0, row[key]) / total) * 1000) / 10)} %`
                        : ''}
                    </td>
                  </>
                ) : (
                  (scatter && spec.series.length === 1 ? spec.series.slice(0, 1) : spec.series).map(
                    (s) => (
                      <td key={s.key} className="num mono">
                        {formatValue(row[s.key], s.valueFormat, s, spec.currency)}
                      </td>
                    ),
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {spec.data.length > DATA_SHOWN_ROWS ? (
        <div className="cr-dt-f">
          {t('chat.chart.capped', {
            shown: number.format(DATA_SHOWN_ROWS),
            total: number.format(spec.data.length),
          })}
        </div>
      ) : null}
    </>
  );
}

const NO_HIDDEN: readonly string[] = [];

/**
 * A chart already validated: its card (design round 41), with «Ver datos» / «Ver gráfica» and
 * «Copiar datos» in its header and the drawing loaded on demand. The hidden series stay while
 * the person switches to the table and back.
 */
export const ChartCard = memo(function ChartCard({ spec }: { spec: ChartSpec }) {
  const { t } = useTranslation();
  const { onCopied } = useChatFilesScope();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [hidden, setHidden] = useState<readonly string[]>(NO_HIDDEN);
  const onToggle = useCallback((key: string) => {
    setHidden((h) => (h.includes(key) ? h.filter((k) => k !== key) : [...h, key]));
  }, []);
  const onShowAll = useCallback(() => {
    setHidden(NO_HIDDEN);
  }, []);
  const actions = (
    <div className="cr-chart-a">
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => {
          setView((v) => (v === 'chart' ? 'table' : 'chart'));
        }}
      >
        {view === 'chart' ? (
          <>
            <TableIcon size={12} /> {t('chat.chart.viewData')}
          </>
        ) : (
          <>
            <BarChartIcon size={12} /> {t('chat.chart.viewChart')}
          </>
        )}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label={t('chat.chart.copy')}
        title={t('chat.chart.copyTitle')}
        onClick={() => {
          // Only after the person's click, and only as plain text (D118 (4)).
          void copyText(chartTsv(spec)).then(
            () => onCopied?.(),
            () => undefined,
          );
        }}
      >
        <CopyIcon size={12} />
      </button>
    </div>
  );
  return (
    <div className="cr-chart">
      <Head spec={spec} actions={actions} />
      {view === 'table' ? (
        <DataView spec={spec} />
      ) : (
        <Suspense fallback={<Loading />}>
          <ChartView spec={spec} hidden={hidden} onToggle={onToggle} onShowAll={onShowAll} />
        </Suspense>
      )}
    </div>
  );
});

/**
 * A ```` ```mango-chart ```` block of the answer's text (D118 (2)), validated with the same
 * closed spec as a chart of a cell. While the answer streams, a block that does not parse yet
 * is still arriving: «Cargando la gráfica…»; once it ended, it is invalid.
 */
export const ChartBlock = memo(function ChartBlock({
  body,
  streaming,
}: {
  body: string;
  streaming: boolean;
}) {
  const spec = useMemo(() => parseChartBlock(body), [body]);
  if (spec) return <ChartCard spec={spec} />;
  if (streaming) {
    return (
      <div className="cr-chart">
        <Loading />
      </div>
    );
  }
  return <InvalidChart />;
});

/**
 * A notice in a chart's or a table's card that is not the chart itself (design round 41): held
 * by the guardrail, amber with a lock and without «Reintentar»; a failed read, with it.
 */
export function OutputNotice({
  tone,
  children,
  onRetry,
  retry,
}: {
  tone: 'lock' | 'warn';
  children: ReactNode;
  onRetry?: () => void;
  retry?: string;
}) {
  const held = tone === 'lock';
  return (
    <div className={`mc-alert${held ? ' amber' : ''}`} role={held ? 'status' : 'alert'}>
      {held ? <LockIcon size={14} /> : <WarnIcon size={14} />}
      <div className="flex-1">{children}</div>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          <RefreshIcon size={11} /> {retry}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Design round 40 and 41 `ChatChart`: a chart a cell wrote (`<name>.chart.json`), read from the API
 * once its malware scan let it be read. A file blocked by the scan or no longer there says so
 * with its card, as a figure does.
 */
export const ChatChartFile = memo(function ChatChartFile({ file }: { file: CodeFile }) {
  const { t } = useTranslation();
  const scan = useFileView(file.file_id, file.gone ?? false);
  const [attempt, setAttempt] = useState(0);
  const view = useChatOutput(file.file_id, scan === 'ready', attempt);
  if (scan === 'blocked' || scan === 'gone') return <FileCard file={file} compact={false} />;
  if (view.kind === 'ready' && view.output.chart) return <ChartCard spec={view.output.chart} />;
  if (view.kind === 'invalid' || (view.kind === 'ready' && !view.output.chart)) {
    return <InvalidChart />;
  }
  if (view.kind === 'withheld') {
    return (
      <div className="cr-chart">
        <OutputNotice tone="lock">{t('chat.chart.withheld')}</OutputNotice>
      </div>
    );
  }
  if (view.kind === 'error') {
    return (
      <div className="cr-chart">
        <OutputNotice
          tone="warn"
          retry={t('chat.chart.retry')}
          onRetry={() => {
            setAttempt((n) => n + 1);
          }}
        >
          {t('chat.chart.error')}
        </OutputNotice>
      </div>
    );
  }
  return (
    <div className="cr-chart">
      <Loading />
    </div>
  );
});
