import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * PGlite ships a WASM Postgres that reads and writes the real filesystem.
   * Bundling it rewrites its Node built-in usage and the data directory ends
   * up crossing a realm boundary, which surfaces as
   * `ERR_INVALID_ARG_TYPE: Received an instance of URL`. Leaving it external
   * lets it load as a plain Node dependency.
   *
   * Argon2 is a native addon and must never be bundled either.
   */
  serverExternalPackages: ["@electric-sql/pglite", "@node-rs/argon2"],
};

export default nextConfig;
