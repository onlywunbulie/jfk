import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** True when DATABASE_URL points at in-process PGlite rather than a server. */
export function isEmbeddedUrl(url: string): boolean {
  return url.startsWith("file:") || url === "memory://";
}

/**
 * Turn a `file:` URL into a PGlite data directory, creating its parent first.
 *
 * PGlite calls a non-recursive `mkdir`, so `file:./.data/jfk` fails unless
 * `.data` already exists. Both the app and the migration runner go through
 * here so neither has to remember that.
 */
export function resolveDataDir(url: string): string {
  if (url === "memory://") return "memory://";

  const dir = url.replace(/^file:/, "");
  mkdirSync(dirname(dir), { recursive: true });
  return dir;
}
