import { z } from "zod";

/**
 * Server-side environment. Validated once at module load so a misconfigured
 * deploy fails at boot rather than halfway through a payment.
 *
 * Never import this from a Client Component — it would leak secrets into the
 * browser bundle. Client-safe values belong on `NEXT_PUBLIC_*` and are read
 * directly from `process.env` at the point of use.
 */
const serverEnvSchema = z.object({
  /**
   * Either an embedded PGlite data directory (`file:./.data/jfk`, `memory://`)
   * or a real Postgres server. `src/lib/db` picks the driver from the scheme.
   */
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.startsWith("file:") ||
        value === "memory://" ||
        /^postgres(ql)?:\/\//.test(value),
      "must be a postgresql:// URL, a file: path, or memory://",
    ),
  APP_URL: z.url(),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters"),
  RESEND_API_KEY: z.string().optional().default(""),
  EMAIL_FROM: z.string().default("Rallied <noreply@rallied.local>"),
  PAYSTACK_SECRET_KEY: z.string().optional().default(""),
  /** Base RPC endpoint. The public one is rate-limited but fine for development. */
  BASE_RPC_URL: z.url().optional(),
  /**
   * The app wallet that pays network fees for starting groups on-chain.
   * Testnet only. It is never an owner of any Safe and has no power over one.
   */
  RELAYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key")
    .optional(),
  /**
   * Coinbase Developer Platform's paymaster for Base Sepolia, so Rallied pays
   * the network fee when a member sends a proposal or votes from their own
   * wallet. The URL contains a secret key: server-side only, never sent to
   * the browser (the browser goes through Rallied's own proxy).
   */
  PAYMASTER_URL: z.url().optional(),
  /**
   * Vercel Blob, for group pictures and banners. Vercel sets it once a Blob
   * store is connected to the project. Without it, uploads say they aren't
   * set up and groups keep their first letter and empty banner.
   */
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env.local and fill it in.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/** True when we should print OTP codes to the terminal instead of emailing. */
export function isEmailDisabled(): boolean {
  return env().RESEND_API_KEY.trim() === "";
}
