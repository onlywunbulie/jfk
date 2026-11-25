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

  /** No "X-Powered-By: Next.js": nothing gained by announcing the framework. */
  poweredByHeader: false,

  /**
   * Security headers on every page. The one that matters most: no other site
   * may put Rallied in a frame, so nobody can lay a page over the "Allow"
   * on the AI approval screen or "Confirm in my wallet" and trick a tap.
   * (The wallet opens in its own window, not a frame, so this costs nothing.)
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // The service worker is always fetched fresh, so a fix reaches every device at once.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },

  /**
   * Dev only. Lets a testing tunnel load the dev server's assets: Cloudflare
   * and ngrok for opening the app on a phone, and Tailscale Funnel for
   * connecting Claude. Without it Next refuses `/_next/*` to any origin but
   * localhost and the page arrives unhydrated (it shows, but taps do nothing).
   * `**.ts.net` because Funnel hosts have two labels (machine.tailnet.ts.net).
   */
  allowedDevOrigins: ["*.trycloudflare.com", "*.ngrok-free.dev", "*.ngrok-free.app", "**.ts.net"],

  experimental: {
    /**
     * Dev only. Turbopack's on-disk cache writes and compacts hundreds of MB
     * in the background; on a spinning disk that stalled reloads for 15–95s.
     * Off, a restart compiles from scratch, but reloads stay fast.
     */
    turbopackFileSystemCacheForDev: false,
  },
};

export default nextConfig;
