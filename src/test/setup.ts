/**
 * Test environment defaults.
 *
 * `memory://` gives every suite a real Postgres that vanishes on exit, and an
 * empty RESEND_API_KEY keeps email in its logging mode so no test can send one.
 */
// `NODE_ENV` is typed read-only by @types/node; write through a plain record.
const environment = process.env as Record<string, string | undefined>;

environment.DATABASE_URL ??= "memory://";
environment.APP_URL ??= "http://localhost:3000";
environment.NODE_ENV ??= "test";
environment.SESSION_SECRET ??=
  "test-only-secret-that-is-definitely-long-enough-to-pass";
environment.RESEND_API_KEY = "";
