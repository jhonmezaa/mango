import type { ReactNode, SVGProps } from 'react';

// Icon set ported from docs/design/mango-hub/src/icons.jsx (only the icons the app uses).
// Decorative by default (aria-hidden); icon-only buttons must carry their own aria-label.

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
}

function createIcon(name: string, paths: ReactNode) {
  function Icon({ size = 14, ...rest }: IconProps) {
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
  Icon.displayName = `Icon${name}`;
  return Icon;
}

export const SearchIcon = createIcon(
  'Search',
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>,
);

export const PlusIcon = createIcon('Plus', <path d="M12 5v14M5 12h14" />);

export const CloseIcon = createIcon('Close', <path d="M6 6l12 12M18 6L6 18" />);

export const ChevronRightIcon = createIcon('ChevronRight', <path d="m9 6 6 6-6 6" />);

export const ChatIcon = createIcon(
  'Chat',
  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />,
);

export const ShieldIcon = createIcon(
  'Shield',
  <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />,
);

export const MoneyIcon = createIcon(
  'Money',
  <>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M6 10v4M18 10v4" />
  </>,
);

export const ActivityIcon = createIcon('Activity', <path d="M3 12h4l2-7 4 14 2-7h6" />);

export const ClockIcon = createIcon(
  'Clock',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);

export const LockIcon = createIcon(
  'Lock',
  <>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </>,
);

export const SunIcon = createIcon(
  'Sun',
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </>,
);

export const MoonIcon = createIcon(
  'Moon',
  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />,
);

export const MenuIcon = createIcon(
  'Menu',
  <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
);

export const SendIcon = createIcon('Send', <path d="m4 12 16-8-6 16-2-7-8-1Z" />);

export const StopIcon = createIcon('Stop', <rect x="6" y="6" width="12" height="12" rx="1.5" />);

export const RefreshIcon = createIcon(
  'Refresh',
  <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />,
);

export const ArrowRightIcon = createIcon('ArrowRight', <path d="M5 12h14m0 0-6-6m6 6-6 6" />);

export const ExternalIcon = createIcon(
  'External',
  <path d="M14 4h6v6M10 14 20 4M15 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h7" />,
);

export const TerminalIcon = createIcon(
  'Terminal',
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </>,
);

export const WarnIcon = createIcon(
  'Warn',
  <>
    <path d="M12 3 2 20h20L12 3Z" />
    <path d="M12 10v4M12 17h.01" />
  </>,
);

export const ErrorCircleIcon = createIcon(
  'ErrorCircle',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m9 9 6 6M15 9l-6 6" />
  </>,
);

export const CloudIcon = createIcon(
  'Cloud',
  <path d="M17 18a5 5 0 0 0-.8-9.95A7 7 0 0 0 3 11a4 4 0 0 0 4 7h10Z" />,
);

export const ZapIcon = createIcon('Zap', <path d="M13 3 4 14h7l-1 7 9-11h-7l1-7Z" />);

export const SignOutIcon = createIcon(
  'SignOut',
  <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M14 16l4-4-4-4M18 12H8" />,
);

export const ChevronLeftIcon = createIcon('ChevronLeft', <path d="m15 18-6-6 6-6" />);

export const ChevronDownIcon = createIcon('ChevronDown', <path d="m6 9 6 6 6-6" />);

export const MoreHorizontalIcon = createIcon(
  'MoreHorizontal',
  <>
    <circle cx="6" cy="12" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="18" cy="12" r="1.5" />
  </>,
);

export const PauseIcon = createIcon(
  'Pause',
  <>
    <rect x="6" y="5" width="4" height="14" />
    <rect x="14" y="5" width="4" height="14" />
  </>,
);

export const PlayIcon = createIcon('Play', <path d="M7 5v14l12-7Z" />);

export const CheckIcon = createIcon('Check', <path d="m5 12 5 5 9-11" />);

export const TrashIcon = createIcon(
  'Trash',
  <path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M10 11v6M14 11v6" />,
);

export const SettingsIcon = createIcon(
  'Settings',
  <>
    <circle cx="12" cy="12" r="2.5" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.3 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.3l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </>,
);

// Shell navigation (design: shell.jsx NAV_PRIMARY / NAV_ICONS).
export const DashboardIcon = createIcon(
  'Dashboard',
  <>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </>,
);

export const InboxIcon = createIcon(
  'Inbox',
  <>
    <path d="M3 13V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6" />
    <path d="M3 13h5l1 3h6l1-3h5v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4Z" />
  </>,
);

export const StoreIcon = createIcon(
  'Store',
  <>
    <path d="M3 9 4.5 4h15L21 9" />
    <path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z" />
    <path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" />
  </>,
);

export const TicketsIcon = createIcon(
  'Tickets',
  <>
    <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V6Z" />
    <path d="M13 5v2M13 11v2M13 17v2" />
  </>,
);

export const EyeIcon = createIcon(
  'Eye',
  <>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.75" />
  </>,
);

export const Check2Icon = createIcon(
  'Check2',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12 3 3 5-6" />
  </>,
);

export const BotIcon = createIcon(
  'Bot',
  <>
    <rect x="4" y="7" width="16" height="12" rx="3" />
    <path d="M12 4v3M9 12h.01M15 12h.01M9 16h6" />
  </>,
);

export const SkillIcon = createIcon(
  'Skill',
  <path d="M12 2 15 8.5l7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z" />,
);

export const BookOpenIcon = createIcon(
  'BookOpen',
  <path d="M12 6c0-1.5 3-3 9-3v15c-6 0-9 1.5-9 3m0-15c0-1.5-3-3-9-3v15c6 0 9 1.5 9 3m0-15v15" />,
);

export const OrgIcon = createIcon(
  'Org',
  <>
    <rect x="9" y="3" width="6" height="5" rx="1" />
    <rect x="3" y="16" width="6" height="5" rx="1" />
    <rect x="15" y="16" width="6" height="5" rx="1" />
    <path d="M12 8v3M6 16v-2a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v2" />
  </>,
);

export const InfoIcon = createIcon(
  'Info',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8h.01M11 12h1v5h1" />
  </>,
);

export const MoreIcon = createIcon(
  'More',
  <>
    <circle cx="5" cy="12" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="19" cy="12" r="1.5" />
  </>,
);

export const PaperclipIcon = createIcon(
  'Paperclip',
  <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3l7.5-7.5" />,
);

export const CopyIcon = createIcon(
  'Copy',
  <>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M4 16V6a2 2 0 0 1 2-2h10" />
  </>,
);

export const ThumbsUpIcon = createIcon(
  'ThumbsUp',
  <path d="M7 10v11H4V10h3Zm0 0 5-7c1.5 0 2 1 2 2v4h5a2 2 0 0 1 2 2.3l-1 7A2 2 0 0 1 18 20h-8l-3-1" />,
);

export const ThumbsDownIcon = createIcon(
  'ThumbsDown',
  <path d="M7 14V3H4v11h3Zm0 0 5 7c1.5 0 2-1 2-2v-4h5a2 2 0 0 0 2-2.3l-1-7A2 2 0 0 0 18 4h-8l-3 1" />,
);

export const EditIcon = createIcon(
  'Edit',
  <path d="M12 20h9M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />,
);

export const CommandIcon = createIcon(
  'Command',
  <>
    <path d="M6 3a3 3 0 1 1 0 6H3V6a3 3 0 0 1 3-3ZM18 3a3 3 0 1 0 0 6h3V6a3 3 0 0 0-3-3ZM6 21a3 3 0 1 0 0-6h3v3a3 3 0 0 1-3 3ZM18 21a3 3 0 1 1 0-6h-3v3a3 3 0 0 0 3 3Z" />
    <rect x="9" y="9" width="6" height="6" />
  </>,
);

export const DownloadIcon = createIcon('Download', <path d="M12 3v13m0 0-4-4m4 4 4-4M5 21h14" />);

export const X2Icon = createIcon(
  'X2',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m9 9 6 6M15 9l-6 6" />
  </>,
);

export const FilterIcon = createIcon('Filter', <path d="M3 5h18l-7 9v6l-4-2v-4L3 5Z" />);

export const UserIcon = createIcon(
  'User',
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </>,
);

export const GlobeIcon = createIcon(
  'Globe',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </>,
);
