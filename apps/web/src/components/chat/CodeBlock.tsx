import type { TFunction } from 'i18next';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CodeCell, CodeFile } from '../../api/codeSchemas';
import {
  codeBlockMs,
  codeBlockState,
  codeFigures,
  shownStderr,
  type CodeBlockData,
  type CodeBlockState,
} from '../../hooks/codeBlock';
import { formatDuration } from '../../lib/format';
import {
  Check2Icon,
  ChevronRightIcon,
  DownloadIcon,
  ExpandIcon,
  InfoIcon,
  LockIcon,
  PauseIcon,
  RefreshIcon,
  WarnIcon,
  X2Icon,
} from '../icons';
import { Modal } from '../Modal';
import { useDownload, useFileView, useImageUrl, type DownloadFailure } from './chatFiles';
import { FileCard } from './FileCard';

/**
 * Design round 40 `CodeBlock` (D114 (7), C4): one header for every cell of the answer, folded by
 * default; the figures are always seen. Everything in a cell is untrusted text from the model
 * and the sandbox, already checked by the guardrail on the server: it is shown as text only.
 */
const HEAD = {
  running: 'chat.code.running',
  completed: 'chat.code.completed',
  error: 'chat.code.error',
  paused: 'chat.code.paused',
} as const satisfies Record<CodeBlockState, string>;

function HeadIcon({ state }: { state: CodeBlockState }) {
  if (state === 'running') return <span className="spinner" aria-hidden="true" />;
  if (state === 'error') return <X2Icon size={13} />;
  if (state === 'paused') return <PauseIcon size={12} />;
  return <Check2Icon size={13} />;
}

function exceptionText(cell: CodeCell): string | null {
  if (cell.exception) {
    return cell.exception.message
      ? `${cell.exception.name}: ${cell.exception.message}`
      : cell.exception.name;
  }
  return null;
}

/** The first line of the first failure, under the folded header of a block in error. */
function failureLine(cells: CodeCell[], cutoff: string): string | null {
  for (const cell of cells) {
    if (cell.blocked) continue;
    if (cell.status === 'timeout') return cutoff;
    const text = exceptionText(cell) ?? (cell.status === 'error' ? shownStderr(cell) : null);
    if (text) return text.split('\n')[0] ?? null;
  }
  return null;
}

function Cell({ cell, index }: { cell: CodeCell; index: number }) {
  const { t } = useTranslation();
  const stderr = shownStderr(cell);
  const exception = exceptionText(cell);
  return (
    <div className="cr-cell">
      <div className="cr-cell-h">
        <span className="mono">{t('chat.code.cell', { n: index + 1 })}</span>
        {cell.seconds ? <span className="mono">{formatDuration(cell.seconds * 1000)}</span> : null}
      </div>
      {cell.blocked ? (
        <div className="cr-cell-blk">
          <LockIcon size={12} /> {t('chat.code.blocked')}
        </div>
      ) : (
        <>
          <pre className="cr-pre mono">{cell.code}</pre>
          {cell.stdout ? (
            <div className="cr-out is-stdout">
              <span className="cr-out-k mono">STDOUT</span>
              <pre className="mono">{cell.stdout}</pre>
            </div>
          ) : null}
          {stderr ? (
            <div className="cr-out is-stderr">
              <span className="cr-out-k mono">STDERR</span>
              <pre className="mono">{stderr}</pre>
            </div>
          ) : null}
          {cell.stdout_truncated || cell.stderr_truncated ? (
            <div className="cr-note">
              <InfoIcon size={11} /> {t('chat.code.truncated')}
            </div>
          ) : null}
          {cell.status === 'timeout' ? (
            <div className="cr-exc">
              <span className="cr-out-k mono">{t('chat.code.timeoutLabel')}</span>
              <pre className="mono">{t('chat.code.timeout')}</pre>
            </div>
          ) : exception ? (
            <div className="cr-exc">
              <span className="cr-out-k mono">{t('chat.code.exceptionLabel')}</span>
              <pre className="mono">{exception}</pre>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function RunningCell({ index, paused }: { index: number; paused: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="cr-cell">
      <div className="cr-cell-h">
        <span className="mono">{t('chat.code.cell', { n: index + 1 })}</span>
        {paused ? (
          <span>{t('chat.code.unfinished')}</span>
        ) : (
          <span className="flex items-center gap-1">
            <span className="spinner" aria-hidden="true" /> {t('chat.code.cellRunning')}
          </span>
        )}
      </div>
    </div>
  );
}

function failureText(t: TFunction, f: DownloadFailure) {
  return f.kind === 'rate' ? t('chat.file.rate', { count: f.minutes }) : t('chat.file.dlError');
}

/** Design round 40 `CrFigure`: an image the cell wrote, read as a `blob:` from the API. */
function Figure({ file }: { file: CodeFile }) {
  const { t } = useTranslation();
  const view = useFileView(file.file_id, false);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [failure, setFailure] = useState<DownloadFailure | null>(null);
  const download = useDownload();
  const image = useImageUrl(file.file_id, view === 'ready', attempt);
  if (view === 'blocked' || view === 'gone') {
    // Not an image that can be shown any more: its card says why.
    return <FileCard file={file} compact />;
  }
  const save = () => {
    void download(file).then(setFailure);
  };
  const loading = view === 'scan' || (!image.url && !image.failed);
  return (
    <figure className="cr-fig">
      {loading ? (
        <div className="cr-fig-img is-load" role="status" aria-label={t('chat.figure.loading')}>
          <span className="spinner" aria-hidden="true" />
        </div>
      ) : image.failed || !image.url ? (
        <div className="cr-fig-img is-err" role="alert">
          <WarnIcon size={15} />
          <span>{t('chat.figure.error')}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setAttempt((n) => n + 1);
            }}
          >
            <RefreshIcon size={11} /> {t('chat.figure.retry')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="cr-fig-btn"
          onClick={() => {
            setZoom(true);
          }}
          aria-label={t('chat.figure.expand', { name: file.name })}
        >
          <img className="cr-fig-pic" src={image.url} alt={file.name} loading="lazy" />
        </button>
      )}
      <figcaption className="flex items-center justify-between">
        <span className="mono">{file.name}</span>
        {image.url ? (
          <span className="flex items-center gap-1">
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              title={t('chat.figure.expandShort')}
              aria-label={t('chat.figure.expand', { name: file.name })}
              onClick={() => {
                setZoom(true);
              }}
            >
              <ExpandIcon size={11} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              title={t('chat.figure.downloadShort')}
              aria-label={t('chat.figure.download', { name: file.name })}
              onClick={save}
            >
              <DownloadIcon size={11} />
            </button>
          </span>
        ) : null}
      </figcaption>
      {failure ? (
        <div className="cr-file-s is-red" role="alert">
          {failureText(t, failure)}
        </div>
      ) : null}
      {zoom && image.url ? (
        <Modal
          title={file.name}
          wide
          onClose={() => {
            setZoom(false);
          }}
          footer={
            <button type="button" className="btn btn-sm" onClick={save}>
              <DownloadIcon size={11} /> {t('chat.figure.downloadShort')}
            </button>
          }
        >
          <img className="cr-fig-pic is-big" src={image.url} alt={file.name} />
        </Modal>
      ) : null}
    </figure>
  );
}

interface Props {
  block: CodeBlockData;
  /** The answer is still streaming: a call without its cell is running, not paused. */
  streaming: boolean;
}

export const CodeBlock = memo(function CodeBlock({ block, streaming }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const state = codeBlockState(block, streaming);
  const count = block.cells.length + block.pending;
  const total = codeBlockMs(block);
  const figures = codeFigures(block);
  const failure = state === 'error' ? failureLine(block.cells, t('chat.code.timeout')) : null;
  return (
    <div className={`cr-code is-${state}`} aria-busy={state === 'running'}>
      <button
        type="button"
        className="cr-code-h"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        <HeadIcon state={state} />
        <span className="cr-code-t" role={state === 'running' ? 'status' : undefined}>
          {t(HEAD[state])}
        </span>
        <span className="cr-code-m mono">
          {t('chat.code.cells', { count })}
          {total && state !== 'running' ? ` · ${formatDuration(total)}` : ''}
        </span>
        <span className="cr-code-o">
          {open ? t('chat.code.hide') : t('chat.code.show')}{' '}
          <ChevronRightIcon size={10} className={open ? 'tool-chevron is-open' : 'tool-chevron'} />
        </span>
      </button>
      {!open && failure ? <div className="cr-code-sum mono">{failure}</div> : null}
      {!open && state === 'paused' ? (
        <div className="cr-code-sum">{t('chat.code.pausedNote')}</div>
      ) : null}
      {open ? (
        <div className="cr-code-b">
          {block.cells.map((cell, index) => (
            <Cell key={cell.run_id} cell={cell} index={index} />
          ))}
          {Array.from({ length: block.pending }, (_, i) => (
            <RunningCell
              key={`pending-${String(i)}`}
              index={block.cells.length + i}
              paused={state !== 'running'}
            />
          ))}
        </div>
      ) : null}
      {figures.length > 0 ? (
        <div className="cr-figs">
          {figures.map((file) => (
            <Figure key={file.file_id} file={file} />
          ))}
        </div>
      ) : null}
    </div>
  );
});
