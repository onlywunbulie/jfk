/**
 * Icons from Iconoir (iconoir.com, MIT licence, v7.10.1), copied as drawn:
 * a 24px grid with a 1.5 stroke. Only the few Rallied uses, so there is no
 * package to keep up to date. To add one: copy its regular SVG from the
 * Iconoir site, keep the paths, swap colours for currentColor.
 */

const svg = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  "aria-hidden": true,
} as const;

/** Iconoir "wallet": the group's balance. */
export function WalletIcon({ className }: { className?: string }) {
  return (
    <svg {...svg} className={className}>
      <path d="M19 20H5C3.89543 20 3 19.1046 3 18V9C3 7.89543 3.89543 7 5 7H19C20.1046 7 21 7.89543 21 9V18C21 19.1046 20.1046 20 19 20Z" />
      <path
        d="M16.5 14C16.2239 14 16 13.7761 16 13.5C16 13.2239 16.2239 13 16.5 13C16.7761 13 17 13.2239 17 13.5C17 13.7761 16.7761 14 16.5 14Z"
        fill="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M18 7V5.60322C18 4.28916 16.7544 3.33217 15.4847 3.67075L4.48467 6.60409C3.60917 6.83756 3 7.63046 3 8.53656V9" />
    </svg>
  );
}

/** Iconoir "group": the group's members. */
export function GroupIcon({ className }: { className?: string }) {
  return (
    <svg {...svg} className={className}>
      <path d="M1 20V19C1 15.134 4.13401 12 8 12V12C11.866 12 15 15.134 15 19V20" strokeLinecap="round" />
      <path d="M13 14V14C13 11.2386 15.2386 9 18 9V9C20.7614 9 23 11.2386 23 14V14.5" strokeLinecap="round" />
      <path d="M8 12C10.2091 12 12 10.2091 12 8C12 5.79086 10.2091 4 8 4C5.79086 4 4 5.79086 4 8C4 10.2091 5.79086 12 8 12Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 9C19.6569 9 21 7.65685 21 6C21 4.34315 19.6569 3 18 3C16.3431 3 15 4.34315 15 6C15 7.65685 16.3431 9 18 9Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Iconoir "edit-pencil": change something. */
export function EditPencilIcon({ className }: { className?: string }) {
  return (
    <svg {...svg} className={className}>
      <path d="M14.3632 5.65156L15.8431 4.17157C16.6242 3.39052 17.8905 3.39052 18.6716 4.17157L20.0858 5.58579C20.8668 6.36683 20.8668 7.63316 20.0858 8.41421L18.6058 9.8942M14.3632 5.65156L4.74749 15.2672C4.41542 15.5993 4.21079 16.0376 4.16947 16.5054L3.92738 19.2459C3.87261 19.8659 4.39148 20.3848 5.0115 20.33L7.75191 20.0879C8.21972 20.0466 8.65806 19.8419 8.99013 19.5099L18.6058 9.8942M14.3632 5.65156L18.6058 9.8942" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Iconoir "user": someone without a name yet. */
export function UserIcon({ className }: { className?: string }) {
  return (
    <svg {...svg} className={className}>
      <path d="M5 20V19C5 15.134 8.13401 12 12 12V12C15.866 12 19 15.134 19 19V20" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 12C14.2091 12 16 10.2091 16 8C16 5.79086 14.2091 4 12 4C9.79086 4 8 5.79086 8 8C8 10.2091 9.79086 12 12 12Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
