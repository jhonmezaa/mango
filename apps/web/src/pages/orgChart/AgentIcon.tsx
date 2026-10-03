import { createElement, type ComponentType } from 'react';

import {
  ActivityIcon,
  BookOpenIcon,
  BotIcon,
  ChatIcon,
  ClockIcon,
  CloudIcon,
  EyeIcon,
  InboxIcon,
  LockIcon,
  MoneyIcon,
  OrgIcon,
  SearchIcon,
  ShieldIcon,
  SkillIcon,
  TerminalIcon,
  TicketsIcon,
  UserIcon,
  WarnIcon,
  ZapIcon,
  type IconProps,
} from '../../components/icons';
import { DatabaseIcon, DocumentIcon } from './icons';

/**
 * Icon names an agent can carry (design admin.jsx `CURATED_ICONS`, plus `Search`). The name comes
 * from the API: it only picks a component from this list, never a path or markup.
 */
const AGENT_ICONS: ReadonlyMap<string, ComponentType<IconProps>> = new Map([
  ['Bot', BotIcon],
  ['Money', MoneyIcon],
  ['Terminal', TerminalIcon],
  ['Shield', ShieldIcon],
  ['Database', DatabaseIcon],
  ['Activity', ActivityIcon],
  ['BookOpen', BookOpenIcon],
  ['Zap', ZapIcon],
  ['Lock', LockIcon],
  ['Cloud', CloudIcon],
  ['Chat', ChatIcon],
  ['Document', DocumentIcon],
  ['Tickets', TicketsIcon],
  ['Org', OrgIcon],
  ['Skill', SkillIcon],
  ['Eye', EyeIcon],
  ['Clock', ClockIcon],
  ['User', UserIcon],
  ['Warn', WarnIcon],
  ['Inbox', InboxIcon],
  ['Search', SearchIcon],
]);

/** The icon of an agent by its name (design: `I[n.icon] || I.Bot`). */
export function AgentIcon({ name, size }: { name: string; size: number }) {
  return createElement(AGENT_ICONS.get(name) ?? BotIcon, { size });
}
