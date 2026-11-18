"use client";

import { useEffect } from "react";

/**
 * Feeds the button hover (`.spotlight` in globals.css): one listener for the
 * whole app tells the button under the pointer where the pointer is, and its
 * soft light follows. Buttons stay server components; nothing re-renders.
 * Only on devices that hover (a mouse or trackpad), never on touch.
 */
export function Spotlight() {
  useEffect(() => {
    if (!window.matchMedia("(hover: hover)").matches) return;
    const move = (event: PointerEvent) => {
      const target = (event.target as Element | null)?.closest?.(".spotlight") as HTMLElement | null;
      if (!target) return;
      const box = target.getBoundingClientRect();
      target.style.setProperty("--spot-x", `${event.clientX - box.left}px`);
      target.style.setProperty("--spot-y", `${event.clientY - box.top}px`);
    };
    document.addEventListener("pointermove", move, { passive: true });
    return () => document.removeEventListener("pointermove", move);
  }, []);
  return null;
}
