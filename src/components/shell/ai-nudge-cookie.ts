/**
 * The cookie that quiets the connect-your-AI nudge. Its own module because
 * the nudge is a client component: a server file importing a plain constant
 * from a "use client" file gets a client reference, not the string.
 */
export const AI_NUDGE_COOKIE = "rallied_ai_nudge_snoozed";
