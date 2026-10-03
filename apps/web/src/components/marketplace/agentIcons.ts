import type { ComponentType } from 'react';

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
} from '../icons';

/**
 * Icons an agent can carry (design admin.jsx `CURATED_ICONS`), by the name the API stores. The
 * name is data: an unknown one falls back to the robot, it is never used to build markup.
 */
const AGENT_ICONS: Readonly<Record<string, ComponentType<IconProps>>> = {
  Activity: ActivityIcon,
  BookOpen: BookOpenIcon,
  Bot: BotIcon,
  Chat: ChatIcon,
  Clock: ClockIcon,
  Cloud: CloudIcon,
  Eye: EyeIcon,
  Inbox: InboxIcon,
  Lock: LockIcon,
  Money: MoneyIcon,
  Org: OrgIcon,
  Search: SearchIcon,
  Shield: ShieldIcon,
  Skill: SkillIcon,
  Terminal: TerminalIcon,
  Tickets: TicketsIcon,
  User: UserIcon,
  Warn: WarnIcon,
  Zap: ZapIcon,
};

/** Design admin.jsx `AGENT_ICON_COLORS` has eight entries; their values are in marketplace.css. */
const COLORS = 8;
/** Icon component and color class of an agent, for avatars with their own size (the chat). */
export function agentIconStyle(
  icon: string,
  color = 0,
): { Icon: ComponentType<IconProps>; colorClass: string } {
  const Icon = (Object.hasOwn(AGENT_ICONS, icon) ? AGENT_ICONS[icon] : undefined) ?? BotIcon;
  const index = Number.isInteger(color) && color >= 0 && color < COLORS ? color : 0;
  return { Icon, colorClass: `mk-avatar-c${String(index)}` };
}
