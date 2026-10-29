import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { ChatMarkdown } from '../../components/ChatMarkdown';
import { ConnectCard } from '../connections/ConnectCard';
import { useStripSources } from '../connections/useStripSources';
import {
  Check2Icon,
  ChevronRightIcon,
  LockIcon,
  RefreshIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  X2Icon,
} from '../../components/icons';
import { SoonTag } from '../../components/Soon';
import { formatCost, formatCount, formatSeconds, type Entry } from './model';

export type Vote = 'up' | 'down' | null;

interface Props {
  entry: Entry;
  /** Name of the column's model, shown next to its label. */
  modelName: string;
  input: string;
  canRun: boolean;
  traceOpen: boolean;
  vote: Vote;
  onToggleTrace: (key: string) => void;
  onVote: (key: string, vote: Vote) => void;
  onRetry: (input: string) => void;
}

/**
 * One answer of a test (design playground.jsx, the result card). The model's text goes through
 * ChatMarkdown, as in the chat: never raw HTML (AGENTS.md, informe §5 (1)).
 */
export const RunCard = memo(function RunCard({
  entry,
  modelName,
  input,
  canRun,
  traceOpen,
  vote,
  onToggleTrace,
  onVote,
  onRetry,
}: Props) {
  const { t } = useTranslation();
  const { column, done, state } = entry;
  const strip = useStripSources(entry.connections);
  const calls = entry.tools.length + entry.writes.length;
  const failed = entry.tools.filter((call) => call.status === 'error').length;
  const flags = done?.flags;
  const label = column.label
    ? column.label.key === 'model'
      ? t('playground.column.model', { model: column.label.model ?? '' })
      : t(`playground.column.${column.label.key}`)
    : null;
  return (
    <div className="card pg-card">
      <div className="pg-card-h">
        <span className="flex items-center gap-2">
          {label && <b>{label}</b>}
          <span className="mono mk-meta">{modelName}</span>
        </span>
        <span className="flex items-center gap-1">
          {flags?.guardrail && (
            <span className="badge badge-amber" title={t('playground.badges.guardrailTitle')}>
              {t('playground.badges.guardrail')}
            </span>
          )}
          {flags?.token_cap && (
            <span className="badge badge-red">{t('playground.badges.tokens')}</span>
          )}
          {flags?.time_limit && (
            <span className="badge badge-red">{t('playground.badges.time')}</span>
          )}
          {flags?.iteration_limit && (
            <span className="badge badge-amber">{t('playground.badges.iterations')}</span>
          )}
        </span>
      </div>
      {calls > 0 && state !== 'queued' && (
        <button
          type="button"
          className="pg-trace-t"
          aria-expanded={traceOpen}
          onClick={() => {
            onToggleTrace(entry.key);
          }}
        >
          <ChevronRightIcon size={10} />
          {t('playground.trace.tools', { count: calls })}
          {entry.writes.length > 0 && (
            <span className="badge badge-amber">{t('playground.trace.askedWrite')}</span>
          )}
          {failed > 0 && (
            <span className="badge badge-red">
              {t('playground.trace.failedCount', { count: failed })}
            </span>
          )}
        </button>
      )}
      {traceOpen && calls > 0 && (
        <div className="pg-trace">
          {entry.tools.map((call, index) => (
            <div key={`${call.name}-${String(index)}`}>
              <span
                className={`tk-dot ${call.status === 'completed' ? 'ok' : call.status === 'error' ? 'error' : 'running'}`}
              />
              <span className="mono">{call.name}</span>
              <span className="mk-meta">
                {call.ms === null
                  ? '…'
                  : t(call.status === 'error' ? 'playground.trace.failed' : 'playground.trace.ok', {
                      seconds: formatSeconds(call.ms),
                    })}
              </span>
            </div>
          ))}
          {entry.writes.map((tool) => (
            <div key={`write-${tool}`}>
              <span className="tk-dot write" />
              <span className="mono">{tool}</span>
              <span className="mk-meta">{t('playground.trace.write')}</span>
            </div>
          ))}
        </div>
      )}
      {state === 'queued' ? (
        <div className="mk-meta pg-wait">{t('playground.queued')}</div>
      ) : (
        <ChatMarkdown streaming={state === 'running'} strip={strip}>
          {entry.text || '…'}
        </ChatMarkdown>
      )}
      {/* Design playground.jsx: the same notice of Mango as in the chat, under the answer. */}
      {state === 'done' &&
        entry.connections.map((registration) => (
          <div key={registration} className="pg-connect">
            <ConnectCard
              registrationId={registration}
              startedAt={entry.connectionAt ?? Date.now()}
              onResend={
                canRun
                  ? () => {
                      onRetry(input);
                    }
                  : undefined
              }
            />
          </div>
        ))}
      {state === 'done' && entry.writes.length > 0 && (
        <div className="mc-alert amber">
          <LockIcon size={13} />
          <div>
            {t('playground.stopped.before')}
            <span className="mono">{entry.writes[0]}</span>
            {t('playground.stopped.after')}
          </div>
        </div>
      )}
      {state === 'error' && (
        <div className="mc-alert red" role="alert">
          <X2Icon size={13} />
          <div className="flex-1">{t('playground.failed')}</div>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!canRun}
            onClick={() => {
              onRetry(input);
            }}
          >
            <RefreshIcon size={11} />
            {t('playground.retry')}
          </button>
        </div>
      )}
      {done && (
        <div className="pg-foot">
          <span className="pg-foot-m mono">
            <span>
              {t('playground.footer.seconds', { seconds: formatSeconds(done.duration_ms) })}
            </span>
            <span>
              {t('playground.footer.tokens', {
                input: formatCount(done.usage.input_tokens),
                output: formatCount(done.usage.output_tokens),
              })}
            </span>
            <span>{t('playground.footer.cost', { cost: formatCost(done.cost_usd) })}</span>
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled
              title={t('playground.saveCaseTitle')}
            >
              <Check2Icon size={12} />
              {t('playground.saveCase')}
              <SoonTag />
            </button>
            <button
              type="button"
              className={vote === 'up' ? 'btn btn-ghost btn-icon pg-on' : 'btn btn-ghost btn-icon'}
              aria-label={t('playground.useful')}
              aria-pressed={vote === 'up'}
              onClick={() => {
                onVote(entry.key, vote === 'up' ? null : 'up');
              }}
            >
              <ThumbsUpIcon size={12} />
            </button>
            <button
              type="button"
              className={
                vote === 'down' ? 'btn btn-ghost btn-icon pg-on' : 'btn btn-ghost btn-icon'
              }
              aria-label={t('playground.notUseful')}
              aria-pressed={vote === 'down'}
              onClick={() => {
                onVote(entry.key, vote === 'down' ? null : 'down');
              }}
            >
              <ThumbsDownIcon size={12} />
            </button>
          </span>
        </div>
      )}
    </div>
  );
});
