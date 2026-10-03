import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { tabId } from './tabId';
import { Tabs, type TabItem } from './Tabs';

type Id = 'active' | 'retired' | 'mine';

function Harness({ tabs }: { tabs: readonly TabItem<Id>[] }) {
  const [active, setActive] = useState<Id>('active');
  return (
    <>
      <Tabs
        label="Agentes"
        tabs={tabs}
        active={active}
        onChange={setActive}
        idPrefix="mk"
        panelId="mk-panel"
      />
      <div id="mk-panel" role="tabpanel" aria-labelledby={tabId('mk', active)}>
        {active}
      </div>
    </>
  );
}

const TABS: TabItem<Id>[] = [
  { id: 'active', label: 'Activos' },
  { id: 'retired', label: 'Retirados', count: 2 },
  { id: 'mine', label: '<b>Míos</b>', count: null },
];

describe('Tabs', () => {
  it('renders the design tab list with counters and links it to the panel', () => {
    render(<Harness tabs={TABS} />);
    const list = screen.getByRole('tablist', { name: 'Agentes' });
    expect(list).toHaveClass('mk-tabs');
    const [first, second, third] = screen.getAllByRole('tab');
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveClass('is-on');
    expect(first).toHaveAttribute('aria-controls', 'mk-panel');
    expect(second).toHaveAttribute('aria-selected', 'false');
    expect(second).toHaveTextContent('Retirados2');
    expect(second?.querySelector('.mk-count')).toHaveTextContent('2');
    // Labels are text, never markup; no counter without a number.
    expect(third).toHaveTextContent('<b>Míos</b>');
    expect(third?.querySelector('.mk-count')).toBeNull();
    expect(screen.getByRole('tabpanel', { name: 'Activos' })).toHaveTextContent('active');
  });

  it('shows a zero counter when the caller passes it', () => {
    render(<Harness tabs={[{ id: 'active', label: 'Catálogo', count: 0 }]} />);
    expect(screen.getByRole('tab')).toHaveTextContent('Catálogo0');
  });

  it('changes tab on click', async () => {
    render(<Harness tabs={TABS} />);
    await userEvent.click(screen.getByRole('tab', { name: /Retirados/ }));
    expect(screen.getByRole('tab', { name: /Retirados/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('retired');
  });

  it('moves with the keyboard and keeps only the active tab in the tab order', async () => {
    render(<Harness tabs={TABS} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    tabs[0]?.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{End}');
    expect(tabs[2]).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(tabs[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(tabs[2]).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(tabs[0]).toHaveFocus();
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
  });
});
