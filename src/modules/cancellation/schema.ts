import { z } from "zod";

/**
 * Shape of `merchants.cancellation_info` (Stage 8 task 1). Zod-validated on
 * every write (the seed refuses bad entries). Data quality beats coverage: a
 * wrong instruction is worse than the generic fallback, so entries carry
 * their `sources` for review.
 */
export const cancellationInfoSchema = z
  .object({
    method: z.enum(["web", "email", "phone", "chat"]),
    url: z.string().url().optional(),
    email: z.string().email().optional(),
    phone: z.string().min(7).optional(),
    steps: z.array(z.string().min(1)).min(1),
    template_id: z.enum(["cancellation", "price_match"]).optional(),
    difficulty: z.number().int().min(1).max(3),
    notes: z.string().optional(),
    /** Where this information was verified (help-center URLs etc.). */
    sources: z.array(z.string().url()).min(1),
  })
  .strict();

export type CancellationInfo = z.infer<typeof cancellationInfoSchema>;

/**
 * The honest fallback when we have no verified data for a merchant. Never a
 * 404 — the user still gets a workable path.
 */
export const GENERIC_GUIDANCE = {
  method: "unknown" as const,
  steps: [
    "Sign in to your account on the merchant's website or app.",
    "Look for Account, Settings, Billing, or Membership — cancellation usually lives there.",
    "No self-serve option? Search their help center for “cancel”, or use their support chat or email and keep a copy of the request.",
    "Watch your next statement. If they keep charging after you cancelled, dispute the charge with your bank — your confirmation is your evidence.",
  ],
  difficulty: 2,
  notes:
    "We don't have verified instructions for this merchant yet, so these are the steps that work almost everywhere.",
};
