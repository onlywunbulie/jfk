"use client";

import Link from "next/link";
import type { Route } from "next";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/cn";

/** One notification as the bell lists it, already formatted on the server. */
export interface InboxItem {
  id: string;
  title: string;
  body: string;
  url: string;
  /** "Today 07:02", "24 Nov". */
  when: string;
  unread: boolean;
}

/**
 * The bell's list: what's new since the member last looked, then what came
 * before. The same notices the phone alerts and Claude's whats_new report.
 * Each one opens the channel it's about.
 */
export function Inbox({ items, onNavigate }: { items: InboxItem[]; onNavigate: () => void }) {
  const fresh = items.filter((item) => item.unread);
  const earlier = items.filter((item) => !item.unread);

  return (
    <div className="space-y-6">
      <h2 id="inbox-title" className="text-lg font-semibold text-ink">
        What needs you
      </h2>
      {items.length === 0 ? (
        <EmptyState illustration="all-set" title="Nothing yet" size="sm">
          New votes, your turn and dues due will show up here.
        </EmptyState>
      ) : (
        <>
          {fresh.length > 0 && <Section title="New" items={fresh} onNavigate={onNavigate} />}
          {earlier.length > 0 && <Section title="Earlier" items={earlier} onNavigate={onNavigate} />}
        </>
      )}
    </div>
  );
}

function Section({ title, items, onNavigate }: { title: string; items: InboxItem[]; onNavigate: () => void }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-ink-muted">{title}</h3>
      <ul className="-mx-3 space-y-1">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={item.url as Route}
              onClick={onNavigate}
              className="press flex gap-3 rounded-[var(--radius-control)] px-3 py-2.5 transition-colors hover:bg-raised"
            >
              <span
                aria-hidden="true"
                className={cn("mt-1.5 size-2 shrink-0 rounded-full", item.unread ? "bg-accent" : "bg-transparent")}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="truncate font-medium text-ink">{item.title}</span>
                  <span className="shrink-0 text-xs text-ink-faint">{item.when}</span>
                </span>
                <span className="mt-0.5 block text-sm text-ink-muted">{item.body}</span>
                {item.unread && <span className="sr-only">New.</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
