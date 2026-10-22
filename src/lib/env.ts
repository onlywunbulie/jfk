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
  EMAIL_FROM: z.string().default("JFK <noreply@jfk.local>"),
  PAYSTACK_SECRET_KEY: z.string().optional().default(""),
  /** Base RPC endpoint. The public one is rate-limited but fine for development. */
  BASE_RPC_URL: z.url().optional(),
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
