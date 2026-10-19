import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { OperationCaller } from '../../api/operations';
import { DocumentIcon, DownloadIcon, RefreshIcon, WarnIcon } from '../../components/icons';
import { openDownload, type RunReport, type Task, type TaskRun } from './model';

const KEEP = new Intl.DateTimeFormat('es-MX', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Design ScRepDl: each click asks for a new link; «Preparando…» while it comes. */
export function ReportDownload({
  api,
  taskId,
  runId,
  button = false,
}: {
  api: OperationCaller;
  taskId: string;
  runId: string;
  button?: boolean;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<'busy' | 'error' | null>(null);
  const go = () => {
    if (state === 'busy') return;
    setState('busy');
    api('downloadTaskReport', {
      path: { task_id: taskId, run_id: runId },
      body: {},
    }).then(
      (link) => {
        setState(openDownload(link.url) ? null : 'error');
      },
      () => {
        setState('error');
      },
    );
  };
  return (
    <>
      <button
        type="button"
        className={button ? 'btn btn-sm' : 'sr-link sc-dl'}
        disabled={state === 'busy'}
        onClick={go}
      >
        {state === 'busy' ? (
          <>
            <span className="g-spin" aria-hidden="true" /> {t('schedules.report.preparing')}
          </>
        ) : (
          <>
            <DownloadIcon size={button ? 12 : 11} />{' '}
            {button ? t('schedules.report.download') : t('schedules.report.downloadPdf')}
          </>
        )}
      </button>
      {state === 'error' ? (
        <span role="alert" className="sc-rep-err">
          {t('schedules.report.downloadError')}
        </span>
      ) : null}
    </>
  );
}

/** Design ScRepState: the PDF in a line of «Ejecuciones recientes». */
export function ReportState({
  report,
  own,
  owner,
}: {
  report: RunReport;
  own: boolean;
  owner: string;
}) {
  const { t } = useTranslation();
  if (report.status === 'generating') {
    return (
      <span className="mk-meta sc-rep-st">
        <span className="g-spin" aria-hidden="true" /> {t('schedules.report.rowGenerating')}
      </span>
    );
  }
  if (report.status === 'failed') {
    return (
      <span className="mk-meta" style={{ color: 'var(--red)' }}>
        {t('schedules.report.rowFailed')}
      </span>
    );
  }
  return own ? null : (
    <span className="mk-meta">{t('schedules.report.rowReadyOther', { owner })}</span>
  );
}

/** Design ScRepCard: the PDF at the top of the result, only for its owner. */
export function ReportCard({
  api,
  task,
  run,
  report,
  retrying,
  onRetry,
}: {
  api: OperationCaller;
  task: Task;
  run: TaskRun;
  report: RunReport;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const name = t(`schedules.report.type.${report.type}`);
  if (report.status === 'generating') {
    return (
      <div className="sc-rep" role="status">
        <span className="sc-rep-i">
          <span className="g-spin" aria-hidden="true" />
        </span>
        <div className="sc-rep-b">
          <b>{t('schedules.report.generatingTitle', { type: name })}</b>
          <span className="mk-meta">{t('schedules.report.generatingBody')}</span>
        </div>
      </div>
    );
  }
  if (report.status === 'failed') {
    const reason = report.reason ?? 'render';
    return (
      <div className="sc-rep bad">
        <span className="sc-rep-i">
          <WarnIcon size={15} />
        </span>
        <div className="sc-rep-b">
          <b>{t('schedules.report.failedTitle', { type: name })}</b>
          <span className="mk-meta">
            {t(`schedules.report.fail.${reason}`)}{' '}
            {reason === 'render'
              ? t('schedules.report.failedRetry')
              : t('schedules.report.failedKeep')}
          </span>
        </div>
        {reason === 'render' ? (
          <button type="button" className="btn btn-sm" disabled={retrying} onClick={onRetry}>
            <RefreshIcon size={12} /> {t('schedules.report.retry')}
          </button>
        ) : null}
      </div>
    );
  }
  const kb = Math.max(1, Math.round((report.size_bytes ?? 0) / 1024));
  return (
    <div className="sc-rep">
      <span className="sc-rep-i">
        <DocumentIcon size={16} />
      </span>
      <div className="sc-rep-b">
        <b>
          {name}
          {report.period ? ` · ${report.period}` : ''}
        </b>
        {report.file ? <span className="mk-meta mono sc-rep-f">{report.file}</span> : null}
        <span className="mk-meta">
          {t('schedules.report.readyMeta', {
            count: report.pages ?? 0,
            kb: kb.toLocaleString('es-MX'),
            until: KEEP.format(new Date(`${report.keep_until}T00:00:00Z`)),
          })}
        </span>
      </div>
      <ReportDownload api={api} taskId={task.task_id} runId={run.run_id} button />
    </div>
  );
}
