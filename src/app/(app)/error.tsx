"use client";

import { Button } from "@/components/ui/button";

/**
 * When a screen inside the app fails to load. Plain words, a reassurance that
 * the money isn't affected (it lives on Base, not in this screen), and Try
 * again. Never the raw error: that goes to the server log.
 */
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 py-12 text-center">
      <p className="text-xl font-semibold text-ink">This screen didn&rsquo;t load</p>
      <p className="max-w-[36ch] text-sm text-pretty text-ink-muted">
        Something went wrong on Rallied&rsquo;s side. Your group&rsquo;s money is safe on Base; only this screen is affected.
      </p>
      <Button type="button" variant="secondary" className="mt-4" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
