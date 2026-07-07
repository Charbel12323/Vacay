import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PLAID_CLIENT_ID: z.string().min(1),
  PLAID_SECRET: z.string().min(1),
  PLAID_ENV: z.enum(["sandbox", "development", "production"]).default("sandbox"),
  TOKEN_ENC_KEY: z.string().min(32, "TOKEN_ENC_KEY must be at least 32 characters"),
  RESEND_API_KEY: z.string().min(1),
  AUTH_SECRET: z.string().min(1),
  // Optional: Google sign-in is offered only when both are set.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Optional: public URL for Plaid webhooks (set in deployed environments or
  // when tunneling locally). Registered on link tokens when present.
  PLAID_WEBHOOK_URL: z.string().url().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Validated environment. Throws (refusing to boot) when required keys are
 * missing or malformed. Import this instead of reading process.env directly.
 */
export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
