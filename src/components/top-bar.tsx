/**
 * The slim bar across the top of the desktop shell: today's date and who is
 * signed in. Deliberately nothing else — search and notifications get a place
 * here when they exist, not before.
 */
export function TopBar({
  user,
}: {
  user: { displayName: string; email: string };
}) {
  // Lagos time, so the date agrees with the month boundaries the money uses.
  const today = new Date().toLocaleDateString("en-NG", {
    weekday: "short",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Africa/Lagos",
  });

  return (
    <div className="hidden items-center justify-end gap-3 px-8 pt-5 lg:flex 2xl:px-12">
      <span className="glass-subtle flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-ink-muted">
        <CalendarIcon />
        {today}
      </span>

      <div className="glass-subtle flex h-9 items-center gap-2.5 rounded-lg pr-3 pl-1.5">
        <Avatar name={user.displayName} />
        <div className="min-w-0 leading-tight">
          <p className="max-w-40 truncate text-sm text-ink">{user.displayName}</p>
        </div>
      </div>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <span
      aria-hidden="true"
      className="grid size-6 shrink-0 place-items-center rounded-full bg-ink text-[0.625rem] font-semibold text-canvas"
    >
      {initials || "?"}
    </span>
  );
}

function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}
