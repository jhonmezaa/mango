import { lazy, memo, Suspense, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { CodeFile } from '../../api/codeSchemas';
import { copyText } from '../../lib/clipboard';
import { CopyIcon, InfoIcon, LockIcon, RefreshIcon, WarnIcon } from '../icons';
import { chartTsv, parseChartBlock, type ChartSpec } from './chartSpec';
import { useChatFilesScope, useChatOutput, useFileView } from './chatFiles';
import { FileCard } from './FileCard';

// Recharts is the largest part of a chart: it loads only when an answer has one (D118 (3)).
const ChartView = lazy(() => import('./ChartView'));

/** Design round 40 `ChatChart` `shell`: the title, its subtitle and «Copiar datos». */
function Shell({ spec, children }: { spec: ChartSpec | null; children: ReactNode }) {
  const { t } = useTranslation();
  const { onCopied } = useChatFilesScope();
  const title = spec?.meta.title;
  return (
    <div className="cr-chart">
      {title ? (
        <div className="cr-chart-h">
          <div>
            <div className="cr-chart-t">{title}</div>
            {spec.meta.subtitle ? <div className="cr-chart-s">{spec.meta.subtitle}</div> : null}
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              void copyText(chartTsv(spec)).then(() => onCopied?.());
            }}
          >
            <CopyIcon size={11} /> {t('chat.chart.copy')}
          </button>
        </div>
      ) : null}
      {children}
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

/** A chart already validated: its card, with the drawing loaded on demand. */
export const ChartCard = memo(function ChartCard({ spec }: { spec: ChartSpec }) {
  return (
    <Shell spec={spec}>
      <Suspense fallback={<Loading />}>
        <ChartView spec={spec} />
      </Suspense>
    </Shell>
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
      <Shell spec={null}>
        <Loading />
      </Shell>
    );
  }
  return <InvalidChart />;
});

/** A notice in a chart's or a table's card that is not the chart itself. */
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
  return (
    <div className={`mc-alert${tone === 'warn' ? ' amber' : ''}`} role="status">
      {tone === 'lock' ? <LockIcon size={14} /> : <WarnIcon size={14} />}
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
 * Design round 40 `ChatChart`: a chart a cell wrote (`<name>.chart.json`), read from the API
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
    <Shell spec={null}>
      <Loading />
    </Shell>
  );
});
