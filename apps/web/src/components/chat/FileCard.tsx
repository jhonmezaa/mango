import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CodeFile } from '../../api/codeSchemas';
import { fileSize } from '../../hooks/codeBlock';
import { DownloadIcon, LockIcon } from '../icons';
import { useChatFilesScope, useDownload, useFileView, type DownloadFailure } from './chatFiles';

/** Design round 40 `CR_KIND`: the kind of a file as the card names it. */
const KIND: Record<string, string> = {
  csv: 'CSV',
  xlsx: 'Excel',
  docx: 'Word',
  pptx: 'PowerPoint',
  pdf: 'PDF',
  png: 'Imagen PNG',
  jpg: 'Imagen JPG',
  jpeg: 'Imagen JPG',
};

type Download = 'prep' | DownloadFailure | null;

/**
 * Design round 40 `FileCard`: a file a cell wrote. «Revisando el archivo…» until its malware
 * scan says, then «Descargar», which asks for a link of 5 minutes and downloads it. The name and
 * the agent are text from the API, rendered escaped.
 */
export const FileCard = memo(function FileCard({
  file,
  compact = false,
}: {
  file: CodeFile;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { agentName, threadTitle } = useChatFilesScope();
  const checked = useFileView(file.file_id, file.gone ?? false);
  const [download, setDownload] = useState<Download>(null);
  const run = useDownload();
  // A download that found the file blocked or gone says so as the card's own state.
  const view =
    download && download !== 'prep' && (download.kind === 'blocked' || download.kind === 'gone')
      ? download.kind
      : checked;
  const ext = file.kind.toLowerCase();
  const go = () => {
    setDownload('prep');
    void run(file).then(setDownload);
  };
  const failed = download !== null && download !== 'prep' ? download : null;
  return (
    <div className={`cr-file is-${view === 'scan' ? 'scan' : view}${compact ? ' is-compact' : ''}`}>
      <span className="cr-file-ic mono">{ext.toUpperCase()}</span>
      <div className="min-w-0 flex-1">
        <div className="cr-file-n">{file.name}</div>
        <div className="cr-file-m">
          {t('chat.file.meta', {
            kind: KIND[ext] ?? ext.toUpperCase(),
            size: fileSize(file.size_bytes),
            agent: agentName,
          })}
          {threadTitle ? ` · ${threadTitle}` : ''}
        </div>
        {view === 'scan' ? (
          <div className="cr-file-s" role="status">
            <span className="spinner" aria-hidden="true" /> {t('chat.file.scanning')}
          </div>
        ) : null}
        {view === 'blocked' ? (
          <div className="cr-file-s is-red" role="alert">
            <LockIcon size={11} /> {t('chat.file.blocked')}
          </div>
        ) : null}
        {view === 'gone' ? <div className="cr-file-s">{t('chat.file.gone')}</div> : null}
        {view === 'ready' && failed?.kind === 'error' ? (
          <div className="cr-file-s is-red" role="alert">
            {t('chat.file.dlError')}
          </div>
        ) : null}
        {view === 'ready' && failed?.kind === 'rate' ? (
          <div className="cr-file-s is-amber" role="alert">
            {t('chat.file.rate', { count: failed.minutes })}
          </div>
        ) : null}
      </div>
      {view === 'ready' ? (
        <button
          type="button"
          className="btn btn-sm"
          disabled={download === 'prep' || failed?.kind === 'rate'}
          onClick={go}
        >
          {download === 'prep' ? (
            <>
              <span className="spinner" aria-hidden="true" /> {t('chat.file.preparing')}
            </>
          ) : (
            <>
              <DownloadIcon size={11} />{' '}
              {failed?.kind === 'error' ? t('chat.file.retry') : t('chat.file.download')}
            </>
          )}
        </button>
      ) : null}
    </div>
  );
});
