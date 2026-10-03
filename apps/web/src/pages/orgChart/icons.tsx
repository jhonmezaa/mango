import type { ReactNode } from 'react';

import type { IconProps } from '../../components/icons';

// Icons of the design (icons.jsx) that only the Org Chart uses so far.
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

export const ExpandIcon = createIcon(
  'Expand',
  <path d="M4 10V4h6M20 14v6h-6M4 4l7 7M20 20l-7-7" />,
);

export const GitBranchIcon = createIcon(
  'GitBranch',
  <>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="12" r="2" />
    <path d="M6 7v10M8 12h8" />
  </>,
);

export const DatabaseIcon = createIcon(
  'Database',
  <>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </>,
);

export const DocumentIcon = createIcon(
  'Document',
  <>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
    <path d="M14 3v6h6M8 13h8M8 17h6" />
  </>,
);
