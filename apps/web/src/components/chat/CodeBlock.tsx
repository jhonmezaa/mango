import type { TFunction } from 'i18next';
import { memo, useId, useState } from 'react';
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
  ImageIcon,
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

/** Where the card of a figure is (design round 41): the block's reference takes the focus there. */
type FigureId = (file: CodeFile) => string;

/** Design round 41: inside the folded block, a figure is a reference to its card below it. */
function FigureRef({ file, id }: { file: CodeFile; id: string }) {
  const { t } = useTranslation();
  return (
    <div className="cr-cell-fig">
      <ImageIcon size={12} />
      <span className="mono">{file.name}</span>
      <span>{t('chat.figure.below')}</span>
      <button
        type="button"
        className="sr-link"
        onClick={() => {
          const card = document.getElementById(id);
          card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          card?.focus({ preventScroll: true });
        }}
      >
        {t('chat.figure.goTo')}
      </button>
    </div>
  );
}

function Cell({ cell, index, figureId }: { cell: CodeCell; index: number; figureId: FigureId }) {
  const { t } = useTranslation();
  const figures = cell.files.filter((file) => file.image && !file.gone);
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
          {figures.map((file) => (
            <FigureRef key={file.file_id} file={file} id={figureId(file)} />
          ))}
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

/**
 * Design round 41 `CrFigure`: one large card per figure, under the block, the width of the
 * message. The image is a `blob:` read from the API; its size is the one the browser read.
 */
function Figure({ file, id }: { file: CodeFile; id: string }) {
  const { t } = useTranslation();
  const view = useFileView(file.file_id, false);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [failure, setFailure] = useState<DownloadFailure | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const download = useDownload();
  const image = useImageUrl(file.file_id, view === 'ready', attempt);
  if (view === 'blocked' || view === 'gone') {
    // Not an image that can be shown any more: its card says why.
    return <FileCard file={file} compact={false} />;
  }
  const save = () => {
    void download(file).then(setFailure);
  };
  const loading = view === 'scan' || (!image.url && !image.failed);
  const meta = size
    ? t('chat.figure.size', { name: file.name, width: size.width, height: size.height })
    : file.name;
  const expand = () => {
    setZoom(true);
  };
  return (
    <figure className="cr-figcard" id={id} tabIndex={-1} aria-label={file.name}>
      <figcaption className="cr-figcard-h">
        <div className="min-w-0">
          <div className="cr-chart-t">{file.name}</div>
          <div className="cr-chart-s mono">{meta}</div>
        </div>
        {image.url ? (
          <div className="cr-chart-a">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              title={t('chat.figure.expandShort')}
              aria-label={t('chat.figure.expand', { name: file.name })}
              onClick={expand}
            >
              <ExpandIcon size={12} />
              <span className="cr-lbl">{t('chat.figure.expandShort')}</span>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              title={t('chat.figure.downloadShort')}
              aria-label={t('chat.figure.download', { name: file.name })}
              onClick={save}
            >
              <DownloadIcon size={12} />
              <span className="cr-lbl">{t('chat.figure.downloadShort')}</span>
            </button>
          </div>
        ) : null}
      </figcaption>
      <div className="cr-figcard-b">
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
            onClick={expand}
            aria-label={t('chat.figure.expand', { name: file.name })}
          >
            <img
              className="cr-fig-pic is-card"
              src={image.url}
              alt={file.name}
              loading="lazy"
              onLoad={(event) => {
                const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
                if (width && height) setSize({ width, height });
              }}
            />
          </button>
        )}
        {failure ? (
          <div className="cr-file-s is-red" role="alert">
            {failureText(t, failure)}
          </div>
        ) : null}
      </div>
      {zoom && image.url ? (
        <Modal
          title={file.name}
          wide
          onClose={() => {
            setZoom(false);
          }}
          footer={
            <div className="flex w-full items-center justify-between gap-2.5">
              <span className="mk-meta mono">{meta}</span>
              <button type="button" className="btn btn-sm" onClick={save}>
                <DownloadIcon size={11} /> {t('chat.figure.downloadShort')}
              </button>
            </div>
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
  const uid = useId();
  const figureId: FigureId = (file) => `crfig-${uid}-${file.file_id}`;
  const failure = state === 'error' ? failureLine(block.cells, t('chat.code.timeout')) : null;
  // Design round 41 order: the block, then its figures, each in a large card under it.
  return (
    <>
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
            {figures.length ? ` · ${t('chat.figure.count', { count: figures.length })}` : ''}
          </span>
          <span className="cr-code-o">
            {open ? t('chat.code.hide') : t('chat.code.show')}{' '}
            <ChevronRightIcon
              size={10}
              className={open ? 'tool-chevron is-open' : 'tool-chevron'}
            />
          </span>
        </button>
        {!open && failure ? <div className="cr-code-sum mono">{failure}</div> : null}
        {!open && state === 'paused' ? (
          <div className="cr-code-sum">{t('chat.code.pausedNote')}</div>
        ) : null}
        {open ? (
          <div className="cr-code-b">
            {block.cells.map((cell, index) => (
              <Cell key={cell.run_id} cell={cell} index={index} figureId={figureId} />
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
      </div>
      {figures.map((file) => (
        <Figure key={file.file_id} file={file} id={figureId(file)} />
      ))}
    </>
  );
});
