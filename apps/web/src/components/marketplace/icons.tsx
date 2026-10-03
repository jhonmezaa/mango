import type { ReactNode } from 'react';

import type { IconProps } from '../icons';

// Icons of the design (icons.jsx) that only the Marketplace uses. Decorative (aria-hidden), like
// the shared set: icon-only buttons carry their own aria-label.

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

export const StarIcon = createIcon(
  'Star',
  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />,
);

export const ShareIcon = createIcon(
  'Share',
  <>
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="5" r="2.5" />
    <circle cx="18" cy="19" r="2.5" />
    <path d="m8 11 8-5M8 13l8 5" />
  </>,
);

export const ArchiveIcon = createIcon(
  'Archive',
  <>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
  </>,
);

export const ListIcon = createIcon(
  'List',
  <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
);
