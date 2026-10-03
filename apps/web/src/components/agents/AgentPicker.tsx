import { useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { isChatable, type Agent } from '../../agents/agents';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { CloseIcon, PlusIcon, SearchIcon } from '../icons';
import { AgentAvatar } from '../marketplace/AgentAvatar';

const ALL = '';
const MAX_RECENT = 4;

interface Props {
  /** Agents the API lists for the user; retired ones are not offered. */
  agents: readonly Agent[];
  /** Agent ids of the user's conversations, most recent first (design «Recientes»). */
  recentAgentIds: readonly string[];
  /**
   * Hint from GET /api/me: «Crear nuevo agente» for who can create (the API authorizes the
   * Builder), «Ver Marketplace» for everyone else.
   */
  canCreate: boolean;
  onPick: (agent: Agent) => void;
  onCreate: () => void;
  onMarketplace: () => void;
  onClose: () => void;
}

function matches(agent: Agent, needle: string): boolean {
  if (!needle) return true;
  return [agent.name, agent.description, agent.category]
    .join(' ')
    .toLocaleLowerCase('es')
    .includes(needle);
}

function PickerCard({
  agent,
  mini = false,
  onPick,
}: {
  agent: Agent;
  mini?: boolean;
  onPick: (agent: Agent) => void;
}) {
  return (
    <button
      type="button"
      className="picker-card"
      onClick={() => {
        onPick(agent);
      }}
    >
      <span className="flex items-start gap-2.5">
        <AgentAvatar icon={agent.icon} color={agent.color} />
        <span className="min-w-0 flex-1 text-left">
          <span className="picker-card-name">{agent.name}</span>
          <span className={mini ? 'picker-card-meta' : 'picker-card-meta mb-1.5'}>
            {agent.category ? `${agent.category} · ` : null}
            {agent.model}
          </span>
          {mini ? null : <span className="picker-card-desc">{agent.description}</span>}
        </span>
      </span>
    </button>
  );
}

/**
 * «Nueva conversación» (design ui.jsx `AgentPicker`): the agents the user may use, with search,
 * categories and the recently used ones. Status dots of the design have no data behind them and
 * are not shown. Every text of an agent comes from its creator and is rendered as text.
 */
export function AgentPicker({
  agents,
  recentAgentIds,
  canCreate,
  onPick,
  onCreate,
  onMarketplace,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const ref = useFocusTrap<HTMLDivElement>(true, onClose);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(ALL);

  const usable = useMemo(() => agents.filter(isChatable), [agents]);
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of usable) {
      if (agent.category) counts.set(agent.category, (counts.get(agent.category) ?? 0) + 1);
    }
    return [...counts];
  }, [usable]);
  const recent = useMemo(() => {
    const byId = new Map(usable.map((agent) => [agent.id, agent]));
    const found: Agent[] = [];
    for (const id of new Set(recentAgentIds)) {
      const agent = byId.get(id);
      if (agent) found.push(agent);
      if (found.length === MAX_RECENT) break;
    }
    return found;
  }, [usable, recentAgentIds]);

  const needle = query.trim().toLocaleLowerCase('es');
  const filtered = usable.filter(
    (agent) => (category === ALL || agent.category === category) && matches(agent, needle),
  );
  const heading = needle
    ? t('agentPicker.results', { count: filtered.length })
    : category === ALL
      ? t('agentPicker.all')
      : category;

  return createPortal(
    <div
      className="overlay picker-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="picker">
        <div className="picker-head">
          <div className="mb-2.5 flex items-start justify-between gap-3">
            <div>
              <h2 id={titleId} className="picker-title">
                {t('agentPicker.title')}
              </h2>
              <p className="picker-sub">{t('agentPicker.subtitle')}</p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={t('common.close')}
              onClick={onClose}
            >
              <CloseIcon size={12} />
            </button>
          </div>
          <div className="search-wrap">
            <SearchIcon size={13} />
            <input
              type="search"
              name="agent-search"
              className="input"
              aria-label={t('agentPicker.search')}
              placeholder={t('agentPicker.searchPlaceholder')}
              value={query}
              maxLength={200}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1">
            <button
              type="button"
              className={category === ALL ? 'pill pill-active' : 'pill'}
              aria-pressed={category === ALL}
              onClick={() => {
                setCategory(ALL);
              }}
            >
              {t('agentPicker.everyone')} <span className="pill-count">{usable.length}</span>
            </button>
            {categories.map(([name, count]) => (
              <button
                key={name}
                type="button"
                className={category === name ? 'pill pill-active' : 'pill'}
                aria-pressed={category === name}
                onClick={() => {
                  setCategory(name);
                }}
              >
                {name} <span className="pill-count">{count}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="picker-body">
          {category === ALL && !needle && recent.length > 0 ? (
            <section className="mb-3.5" aria-labelledby={`${titleId}-recent`}>
              <h3 id={`${titleId}-recent`} className="picker-label">
                {t('agentPicker.recent')}
              </h3>
              <div className="picker-grid picker-grid-mini">
                {recent.map((agent) => (
                  <PickerCard key={agent.id} agent={agent} mini onPick={onPick} />
                ))}
              </div>
            </section>
          ) : null}
          <section aria-labelledby={`${titleId}-list`}>
            <h3 id={`${titleId}-list`} className="picker-label">
              {heading}
            </h3>
            <div className="picker-grid">
              {filtered.map((agent) => (
                <PickerCard key={agent.id} agent={agent} onPick={onPick} />
              ))}
            </div>
            {filtered.length === 0 ? (
              <p className="picker-empty">
                {needle
                  ? t('agentPicker.noMatches', { query: query.trim() })
                  : t('agentPicker.none')}
              </p>
            ) : null}
          </section>
        </div>
        <div className="picker-foot">
          <span>{t('agentPicker.missing')}</span>
          {canCreate ? (
            <button type="button" className="btn btn-sm" onClick={onCreate}>
              <PlusIcon size={11} /> {t('agentPicker.create')}
            </button>
          ) : (
            <button type="button" className="btn btn-sm" onClick={onMarketplace}>
              {t('agentPicker.marketplace')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
