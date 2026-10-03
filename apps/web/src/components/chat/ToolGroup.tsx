import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { DisplayToolCall } from '../../hooks/chatState';
import { Badge } from '../Badge';
import { ChevronDownIcon, ChevronRightIcon, TerminalIcon } from '../icons';
import { Soon } from '../Soon';

const seconds = new Intl.NumberFormat('es', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const DOT_CLASS: Record<DisplayToolCall['status'], string> = {
  started: '',
  completed: 'dot dot-green',
  error: 'dot dot-red',
  interrupted: 'dot dot-gray',
};

function ToolRow({ tool }: { tool: DisplayToolCall }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <li className="tool-row" data-status={tool.status}>
      <button
        type="button"
        className="tool-row-head"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        {tool.status === 'started' ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <span className={DOT_CLASS[tool.status]} aria-hidden="true" />
        )}
        <span className="sr-only">{t(`chat.tools.status.${tool.status}`)}</span>
        {/* Tool names come from the stream (untrusted) and are rendered as text only. */}
        <span className="tool-row-name mono">{tool.name}</span>
        {tool.status === 'error' ? <Badge tone="red">{t('chat.tools.failed')}</Badge> : null}
        {tool.durationMs !== undefined && (
          <span className="tool-row-time mono">
            {t('chat.tools.ms', { ms: Math.round(tool.durationMs) })}
          </span>
        )}
        <ChevronDownIcon size={10} className={open ? 'tool-chevron is-open' : 'tool-chevron'} />
      </button>
      {open && (
        // The SSE `tool` event carries no parameters (design: "Parámetros de la tool" is Soon).
        <div className="tool-row-params">
          <Soon name={t('soon.item', { label: t('chat.tools.params') })}>
            <span className="text-[11.5px]">{t('chat.tools.params')}</span>
          </Soon>
        </div>
      )}
    </li>
  );
}

interface Props {
  tools: DisplayToolCall[];
  /** Observe mode on a turn that is still streaming: the group starts expanded. */
  live: boolean;
}

/**
 * Tool calls of an agent turn collapsed into one "N herramientas · X s" button (design: chat.jsx
 * ToolGroup). The SSE `tool` event only has name and status; durations are measured on the client
 * and absent for loaded history, so the total is shown only when every call was measured.
 */
export function ToolGroup({ tools, live }: Props) {
  const { t } = useTranslation();
  // null = the user has not toggled it yet; follow observe mode until they do.
  const [toggled, setToggled] = useState<boolean | null>(null);
  if (tools.length === 0) return null;
  const open = toggled ?? live;
  const failed = tools.some((tool) => tool.status === 'error' || tool.status === 'interrupted');
  const timed = tools.filter((tool) => tool.durationMs !== undefined);
  const total = timed.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  return (
    <div className="tool-group">
      <button
        type="button"
        className="tool-group-head"
        aria-expanded={open}
        onClick={() => {
          setToggled(!open);
        }}
      >
        <ChevronRightIcon size={10} className={open ? 'tool-chevron is-open' : 'tool-chevron'} />
        <TerminalIcon size={11} className={failed ? 'text-danger' : 'text-ok'} />
        <span>{t('chat.tools.count', { count: tools.length })}</span>
        {timed.length === tools.length && (
          <span className="tool-group-time mono">
            · {t('chat.tools.seconds', { seconds: seconds.format(total / 1000) })}
          </span>
        )}
      </button>
      {open && (
        <ul className="tool-group-list" aria-label={t('chat.tools.listLabel')}>
          {tools.map((tool, index) => (
            <ToolRow key={`${tool.name}-${String(index)}`} tool={tool} />
          ))}
        </ul>
      )}
    </div>
  );
}
