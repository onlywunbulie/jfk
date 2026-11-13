"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The profile, as a modal over whatever screen the user is on. A native
 * <dialog> opened with showModal(), so focus is trapped inside, Escape closes
 * it and the page behind can't be clicked. Tapping the dim area outside also
 * closes it. A centred panel on desktop; a sheet sliding up from the bottom on
 * a phone.
 */
export function ProfileModal({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="profile-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // A click that lands on the dialog itself (not its content) is on the backdrop.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="profile-modal m-0 mt-auto max-h-[90dvh] w-full max-w-none overflow-y-auto rounded-t-[var(--radius-sheet)] border border-border bg-surface p-0 text-ink backdrop:bg-black/60 sm:m-auto sm:max-h-[85dvh] sm:w-[min(36rem,calc(100vw-2rem))] sm:rounded-[var(--radius-big)]"
    >
      <div className="relative p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:p-8">
        {/* The grab bar says "swipe me" on a phone. */}
        <span aria-hidden="true" className="mx-auto -mt-2 mb-4 block h-1 w-10 rounded-full bg-border-strong sm:hidden" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close your profile"
          className="press absolute top-4 right-4 grid size-10 place-items-center rounded-[var(--radius-control)] text-ink-muted hover:bg-raised hover:text-ink"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        {children}
      </div>
    </dialog>
  );
}
