import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Agent } from '../../agents/agents';
import { useSession } from '../../auth/useSession';
import { CloudIcon, RefreshIcon, SkillIcon } from '../icons';

type AgentSkill = NonNullable<Agent['skills']>[number];

/** The skills of the version that answers, as read for one agent. */
type SkillsState =
  { kind: 'loading' } | { kind: 'ready'; skills: readonly AgentSkill[] } | { kind: 'error' };

/** `<pack or connector id>.<tool>` refs -> how many tools of each, in their first order. */
function toolsByServer(tools: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const ref of tools) {
    const server = ref.split('.', 1)[0] ?? ref;
    counts.set(server, (counts.get(server) ?? 0) + 1);
  }
  return [...counts];
}

/**
 * «Qué puede usar {agente}» (design chat.jsx ChatHeader `tools-pop`, round 23, D92 (8)): the
 * skills and the tools of the version that answers. The skills come from the agent's detail,
 * asked for when the popover first opens: the API answers only to who may use the agent and
 * never sends their instructions. Names and descriptions are written by their authors and are
 * rendered as text. The design's MCP latency and health have no backend and are not shown.
 */
/** Rendered with `key={agent.id}`. */
export function ToolsPopover({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { api } = useSession();
  const [open, setOpen] = useState(false);
  // Mounted per agent (`key`): nothing read for another agent is shown here.
  const [read, setRead] = useState<SkillsState | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  const state: SkillsState | null = agent.skills ? { kind: 'ready', skills: agent.skills } : read;

  const load = () => {
    setRead({ kind: 'loading' });
    api.call('getAgent', { path: { agent_id: agent.id } }).then(
      (detail) => {
        setRead(detail.skills ? { kind: 'ready', skills: detail.skills } : { kind: 'error' });
      },
      () => {
        setRead({ kind: 'error' });
      },
    );
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const servers = toolsByServer(agent.tools);
  // Design round 24: both counters say «–» until what the version can use is read.
  const ready = state?.kind === 'ready' ? state : null;
  const skillCount = ready ? String(ready.skills.length) : '–';
  const serverCount = ready ? String(servers.length) : '–';
  return (
    <div ref={rootRef} className="relative chat-soon-tools">
      <button
        type="button"
        className={open ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
        title={t('chat.header.tools')}
        aria-label={t('chat.header.tools')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => {
          // The detail is asked for when the popover first opens, not with the chat.
          if (!open && state === null) load();
          setOpen(!open);
        }}
      >
        <SkillIcon size={11} /> {skillCount} · <CloudIcon size={11} /> {serverCount}
      </button>
      {open && (
        <div
          id={popId}
          className="tools-pop"
          role="dialog"
          aria-label={t('chat.toolsPop.title', { name: agent.name })}
        >
          {ready ? (
            <>
              <div className="tp-head">
                <div className="tp-title">{t('chat.toolsPop.title', { name: agent.name })}</div>
                <div className="tp-sub">{t('chat.toolsPop.subtitle')}</div>
              </div>
              <div className="tp-sec">
                <div className="tp-sec-t">{t('chat.toolsPop.skills', { shown: skillCount })}</div>
                <div className="tp-note">{t('chat.toolsPop.skillsNote')}</div>
                {ready.skills.length === 0 ? (
                  <div className="tp-empty">{t('chat.toolsPop.noSkills')}</div>
                ) : (
                  ready.skills.map((skill) => (
                    <div key={`${skill.id}@${String(skill.version)}`} className="tp-row">
                      <span className="tp-ic" aria-hidden="true">
                        <SkillIcon size={11} />
                      </span>
                      <div className="tp-body">
                        <div className="tp-row-h">
                          <span className="tp-name">{skill.name}</span>
                          <span className="tp-ver mono">
                            {t('chat.toolsPop.version', { version: skill.version })}
                          </span>
                        </div>
                        {skill.description && <div className="tp-desc">{skill.description}</div>}
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="tp-sec is-mcp">
                <div className="tp-sec-t">{t('chat.toolsPop.mcp', { count: servers.length })}</div>
                {servers.map(([server, count]) => (
                  <div key={server} className="tp-mcp">
                    <div className="tp-mcp-id mono">⌘ {server}</div>
                    <div className="tp-mcp-meta">{t('chat.toolsPop.mcpTools', { count })}</div>
                  </div>
                ))}
              </div>
            </>
          ) : state?.kind === 'error' ? (
            <div className="tp-error" role="alert">
              <div className="tp-error-t">{t('chat.toolsPop.error', { name: agent.name })}</div>
              <div className="tp-error-b">{t('chat.toolsPop.errorBody')}</div>
              <button type="button" className="btn btn-sm" onClick={load}>
                <RefreshIcon size={11} /> {t('chat.toolsPop.retry')}
              </button>
            </div>
          ) : (
            <div className="tp-loading" role="status">
              <span className="g-spin" aria-hidden="true" /> {t('chat.toolsPop.loading')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
