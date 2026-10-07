import type { ReactNode } from "react";

/* Inline, 24px grid, 1.75 stroke to match the sidebar and tab bar. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-[1.125rem]"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function VaultIcon() {
  return (
    <Icon>
      <rect x="3.5" y="5" width="17" height="14" rx="3" />
      <circle cx="12" cy="12" r="2.75" />
      <path d="M12 9.25V7.5M7 19v1.5M17 19v1.5" />
    </Icon>
  );
}

export function ArrowDownIcon() {
  return (
    <Icon>
      <path d="M12 4v14m0 0-5.5-5.5M12 18l5.5-5.5" />
    </Icon>
  );
}

export function ArrowUpIcon() {
  return (
    <Icon>
      <path d="M12 20V6m0 0-5.5 5.5M12 6l5.5 5.5" />
    </Icon>
  );
}

export function CalendarIcon() {
  return (
    <Icon>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </Icon>
  );
}

export function BarsIcon() {
  return (
    <Icon>
      <path d="M5 20v-7M12 20V4M19 20v-11" />
    </Icon>
  );
}

export function TargetIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="0.75" fill="currentColor" />
    </Icon>
  );
}

export function SwapIcon() {
  return (
    <Icon>
      <path d="M7 4v16m0 0-3.5-3.5M7 20l3.5-3.5M17 20V4m0 0-3.5 3.5M17 4l3.5 3.5" />
    </Icon>
  );
}

export function PeopleIcon() {
  return (
    <Icon>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.4a6.5 6.5 0 0 1 3.5 5.6" />
    </Icon>
  );
}

export function ScrollIcon() {
  return (
    <Icon>
      <path d="M7 3.5h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" />
      <path d="M9 8.5h6M9 12h6M9 15.5h3.5" />
    </Icon>
  );
}

export function ScalesIcon() {
  return (
    <Icon>
      <path d="M12 4v16M7 20h10M5 7h14" />
      <path d="M5 7 2.5 13a2.6 2.6 0 0 0 5 0L5 7ZM19 7l-2.5 6a2.6 2.6 0 0 0 5 0L19 7Z" />
    </Icon>
  );
}

export function ClockIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}
