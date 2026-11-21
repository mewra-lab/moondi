import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const baseProps: IconProps = {
  'aria-hidden': true,
  fill: 'none',
  height: 18,
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  strokeWidth: 1.75,
  viewBox: '0 0 24 24',
  width: 18,
}

export const CloseIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
)

export const BellIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
  </svg>
)

export const ChevronRightIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="m9 18 6-6-6-6" />
  </svg>
)

export const OverviewIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <rect height="7" rx="1.5" width="7" x="3" y="3" />
    <rect height="7" rx="1.5" width="7" x="14" y="3" />
    <rect height="7" rx="1.5" width="7" x="3" y="14" />
    <rect height="7" rx="1.5" width="7" x="14" y="14" />
  </svg>
)

export const ActivityIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M8 6h12" />
    <path d="M8 12h12" />
    <path d="M8 18h12" />
    <circle cx="4" cy="6" fill="currentColor" r="1" stroke="none" />
    <circle cx="4" cy="12" fill="currentColor" r="1" stroke="none" />
    <circle cx="4" cy="18" fill="currentColor" r="1" stroke="none" />
  </svg>
)

export const HistoryIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <path d="m7 14 4-4 4 3 5-6" />
  </svg>
)

export const SyncIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M3 12a9 9 0 0 1 15.4-6.3L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15.4 6.3L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
)

export const SettingsIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M4 7h10" />
    <path d="M18 7h2" />
    <circle cx="16" cy="7" r="2" />
    <path d="M4 17h4" />
    <path d="M12 17h8" />
    <circle cx="10" cy="17" r="2" />
  </svg>
)

export const EyeIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
)

export const EyeOffIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M10.6 5.7A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.3 4.2" />
    <path d="M14.1 14.1a2.8 2.8 0 0 1-4.2-4.2" />
    <path d="M6.4 7.7A16.5 16.5 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9.3 9.3 0 0 0 4.3-1" />
    <path d="m3 3 18 18" />
  </svg>
)

export const SunIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2" />
    <path d="M12 19.5v2" />
    <path d="m4.9 4.9 1.4 1.4" />
    <path d="m17.7 17.7 1.4 1.4" />
    <path d="M2.5 12h2" />
    <path d="M19.5 12h2" />
    <path d="m4.9 19.1 1.4-1.4" />
    <path d="m17.7 6.3 1.4-1.4" />
  </svg>
)

export const MoonIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a6.8 6.8 0 0 0 11 11Z" />
  </svg>
)

export const SignOutIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </svg>
)

export const ImageCardIcon = (props: IconProps) => (
  <svg {...baseProps} {...props}>
    <rect height="16" rx="2.5" width="18" x="3" y="4" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m21 15-4.5-4.5L7 20" />
  </svg>
)
