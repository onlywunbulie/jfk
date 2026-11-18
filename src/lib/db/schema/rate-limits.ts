import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Counters for rate limits (src/lib/rate-limit.ts): one row per key (say
 * "sign-in:ip:1.2.3.4"), counting requests in the current window. Kept in
 * Postgres so limits hold across every server instance without another
 * service. Rows are tiny and reused; old windows reset in place.
 */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});
