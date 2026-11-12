"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Opens a feed on its newest entries: scrolls the nearest scrolling ancestor
 * (the main card's body) to the bottom when the feed first shows, and again
 * when a filter changes what's in it. Renders nothing visible.
 */
export function ScrollToBottom() {
  const marker = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    let el = marker.current?.parentElement ?? null;
    while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  });

  return <span ref={marker} hidden />;
}
