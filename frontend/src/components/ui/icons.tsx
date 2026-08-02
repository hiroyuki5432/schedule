// Inline stroke icons ported from the mockup (1.7–1.8 stroke, currentColor).
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>

const svg = (props: P) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...props,
})

export const CalendarIcon = (p: P) => (
  <svg {...svg(p)}>
    <rect x="3" y="4" width="18" height="17" rx="2" />
    <path d="M3 9h18M8 2v4M16 2v4" />
  </svg>
)

export const ChartIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </svg>
)

export const TasksIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
  </svg>
)

export const MembersIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M17 20v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8" />
  </svg>
)

export const SettingsIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M3 6h18M7 12h10M10 18h4" />
  </svg>
)

export const FilterIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M3 4h18M3 4l7 8v6l4 2v-8l7-8" />
  </svg>
)

export const PlusIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const DownloadIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
)

export const LogoutIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </svg>
)

export const TableIcon = (p: P) => (
  <svg {...svg(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M3 15h18M9 4v16" />
  </svg>
)

export const GearIcon = (p: P) => (
  <svg {...svg(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 0 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
  </svg>
)

export const TrashIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  </svg>
)

/** Open-in-panel: the per-row 「開く」 affordance in the table view. */
export const ExpandIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M15 3h6v6M21 3l-8 8M9 21H3v-6M3 21l8-8" />
  </svg>
)

export const DiamondIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M12 3l9 9-9 9-9-9z" />
  </svg>
)

export const ChevronUpIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M6 15l6-6 6 6" />
  </svg>
)

export const ChevronDownIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)

export const XIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)

export const SearchIcon = (p: P) => (
  <svg {...svg(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
)

export const MenuIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </svg>
)

export const HelpIcon = (p: P) => (
  <svg {...svg(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3" />
    <path d="M12 17h.01" />
  </svg>
)

export const BellIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
)
