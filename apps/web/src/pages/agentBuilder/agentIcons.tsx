import type { ComponentType, ReactNode } from 'react';

import {
  ActivityIcon,
  BookOpenIcon,
  BotIcon,
  ChatIcon,
  Check2Icon,
  ClockIcon,
  CloudIcon,
  CommandIcon,
  CopyIcon,
  DashboardIcon,
  DownloadIcon,
  EditIcon,
  ExternalIcon,
  EyeIcon,
  FilterIcon,
  GlobeIcon,
  InboxIcon,
  InfoIcon,
  LockIcon,
  MoneyIcon,
  MoonIcon,
  OrgIcon,
  PaperclipIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  ShieldIcon,
  SkillIcon,
  StopIcon,
  StoreIcon,
  SunIcon,
  TerminalIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TicketsIcon,
  TrashIcon,
  UserIcon,
  WarnIcon,
  X2Icon,
  ZapIcon,
  type IconProps,
} from '../../components/icons';

// Icons and colors an agent can take (design admin.jsx `AGENT_ICON_COLORS`, `CURATED_ICONS` and
// the "Ver todos" list). The icon travels as a name; an unknown name falls back to `Bot`.

type Icon = ComponentType<IconProps>;

/** Design icons the app's shared set does not have yet, ported from the design's icons.jsx. */
function designIcon(name: string, paths: ReactNode): Icon {
  function DesignIcon({ size = 14, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {paths}
      </svg>
    );
  }
  DesignIcon.displayName = `Icon${name}`;
  return DesignIcon;
}

const DatabaseIcon = designIcon(
  'Database',
  <>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </>,
);
const DocumentIcon = designIcon(
  'Document',
  <>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
    <path d="M14 3v6h6M8 13h8M8 17h6" />
  </>,
);
const KanbanIcon = designIcon(
  'Kanban',
  <>
    <rect x="3" y="4" width="5" height="16" rx="1.5" />
    <rect x="10" y="4" width="5" height="10" rx="1.5" />
    <rect x="17" y="4" width="4" height="13" rx="1.5" />
  </>,
);
const ListIcon = designIcon('List', <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />);
const SortIcon = designIcon('Sort', <path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" />);
const UploadIcon = designIcon('Upload', <path d="M12 20V7m0 0L8 11m4-4 4 4M5 4h14" />);
const SlidersIcon = designIcon(
  'Sliders',
  <>
    <path d="M4 6h10M20 6h-2M4 12h4M20 12H12M4 18h14M20 18h-2" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="16" cy="18" r="2" />
  </>,
);
const MangoIcon = designIcon(
  'Mango',
  <>
    <path d="M12 3c4 0 7 3 7 7s-3 11-7 11-7-4-7-9 3-9 7-9Z" />
    <path d="M12 3c-1 1-1.5 2-1.5 3" />
  </>,
);
const GitBranchIcon = designIcon(
  'GitBranch',
  <>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="12" r="2" />
    <path d="M6 7v10M8 12h8" />
  </>,
);
const ExpandIcon = designIcon('Expand', <path d="M4 10V4h6M20 14v6h-6M4 4l7 7M20 20l-7-7" />);
const PinIcon = designIcon('Pin', <path d="M12 2v7l4 4-1 2H9l-1-2 4-4V2M12 13v9" />);
const ShareIcon = designIcon(
  'Share',
  <>
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="5" r="2.5" />
    <circle cx="18" cy="19" r="2.5" />
    <path d="m8 11 8-5M8 13l8 5" />
  </>,
);
const ArchiveIcon = designIcon(
  'Archive',
  <>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
  </>,
);

/**
 * Every icon of the design by its name, in the design's order. The names the design leaves out
 * of "Ver todos" (`Search`, `Plus`, chevrons…) only resolve for agents that already carry them.
 */
const ICONS: Readonly<Record<string, Icon>> = {
  Search: SearchIcon,
  Dashboard: DashboardIcon,
  Inbox: InboxIcon,
  Chat: ChatIcon,
  Tickets: TicketsIcon,
  Store: StoreIcon,
  Bot: BotIcon,
  Org: OrgIcon,
  Skill: SkillIcon,
  Shield: ShieldIcon,
  Money: MoneyIcon,
  Activity: ActivityIcon,
  Settings: SettingsIcon,
  Kanban: KanbanIcon,
  List: ListIcon,
  Filter: FilterIcon,
  Sort: SortIcon,
  Send: SendIcon,
  Paperclip: PaperclipIcon,
  Stop: StopIcon,
  Play: PlayIcon,
  Pause: PauseIcon,
  Refresh: RefreshIcon,
  Download: DownloadIcon,
  Upload: UploadIcon,
  External: ExternalIcon,
  Eye: EyeIcon,
  Lock: LockIcon,
  User: UserIcon,
  Warn: WarnIcon,
  Info: InfoIcon,
  Check2: Check2Icon,
  X2: X2Icon,
  Clock: ClockIcon,
  Terminal: TerminalIcon,
  Cloud: CloudIcon,
  Database: DatabaseIcon,
  Zap: ZapIcon,
  Sun: SunIcon,
  Moon: MoonIcon,
  Sliders: SlidersIcon,
  Command: CommandIcon,
  Mango: MangoIcon,
  BookOpen: BookOpenIcon,
  GitBranch: GitBranchIcon,
  Expand: ExpandIcon,
  Trash: TrashIcon,
  Pin: PinIcon,
  Document: DocumentIcon,
  Copy: CopyIcon,
  ThumbsUp: ThumbsUpIcon,
  ThumbsDown: ThumbsDownIcon,
  Share: ShareIcon,
  Globe: GlobeIcon,
  Edit: EditIcon,
  Archive: ArchiveIcon,
};

export const CURATED_ICONS: readonly string[] = [
  'Bot',
  'Money',
  'Terminal',
  'Shield',
  'Database',
  'Activity',
  'BookOpen',
  'Zap',
  'Lock',
  'Cloud',
  'Chat',
  'Document',
  'Tickets',
  'Org',
  'Skill',
  'Eye',
  'Clock',
  'User',
  'Warn',
  'Inbox',
];

/** Design "Ver todos": the whole set except the interface glyphs. */
export const ALL_ICONS: readonly string[] = Object.keys(ICONS).filter((name) => name !== 'Search');

export function agentIcon(name: string): Icon {
  return ICONS[name] ?? BotIcon;
}

export interface AgentColor {
  name: string;
  bg: string;
  color: string;
}

/** Design `AGENT_ICON_COLORS`; the definition stores the index (`color`, 0..7). */
export const AGENT_ICON_COLORS: readonly AgentColor[] = [
  { name: 'amber', bg: '#f9731622', color: '#fb923c' },
  { name: 'green', bg: '#16a34a22', color: '#4ade80' },
  { name: 'blue', bg: '#2563eb22', color: '#60a5fa' },
  { name: 'violet', bg: '#8b5cf622', color: '#a78bfa' },
  { name: 'red', bg: '#dc262622', color: '#f87171' },
  { name: 'yellow', bg: '#eab30822', color: '#facc15' },
  { name: 'teal', bg: '#14b8a622', color: '#2dd4bf' },
  { name: 'slate', bg: '#64748b22', color: '#94a3b8' },
];

const FIRST_COLOR: AgentColor = { name: 'amber', bg: '#f9731622', color: '#fb923c' };

export function agentColor(index: number): AgentColor {
  return AGENT_ICON_COLORS[index] ?? FIRST_COLOR;
}
