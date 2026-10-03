import type { KeyboardEvent } from 'react';

import { tabId } from './tabId';

export interface TabItem<Id extends string> {
  id: Id;
  label: string;
  /** Shown as a counter next to the label when it is a number (design `mk-count`). */
  count?: number | null;
}

interface Props<Id extends string> {
  /** Accessible name of the tab list. */
  label: string;
  tabs: readonly TabItem<Id>[];
  active: Id;
  onChange: (id: Id) => void;
  /** Prefix of the tab ids: the panel points back with `aria-labelledby={tabId(idPrefix, id)}`. */
  idPrefix: string;
  /** Id of the element with `role="tabpanel"`. */
  panelId: string;
}

/**
 * Tabs of the marketplace screens (design `mk-tabs`: Marketplace, agent review, MCP catalog).
 * Keyboard as in the WAI-ARIA tabs pattern: arrows move with wrap-around, Home and End jump, and
 * only the active tab is in the tab order.
 */
export function Tabs<Id extends string>({
  label,
  tabs,
  active,
  onChange,
  idPrefix,
  panelId,
}: Props<Id>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === active);
    const last = tabs.length - 1;
    let next: number;
    if (event.key === 'ArrowRight') next = index >= last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') next = index <= 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else return;
    const target = tabs[next];
    if (!target) return;
    event.preventDefault();
    onChange(target.id);
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div className="mk-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={tabId(idPrefix, tab.id)}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          aria-controls={panelId}
          tabIndex={tab.id === active ? 0 : -1}
          className={tab.id === active ? 'is-on' : undefined}
          onClick={() => {
            onChange(tab.id);
          }}
        >
          {tab.label}
          {typeof tab.count === 'number' ? <span className="mk-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
