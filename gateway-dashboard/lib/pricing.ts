/**
 * Subscription tiers (Step 6.3).
 *
 * The tier drives credit allowance, request rate and concurrency. The values
 * are mirrored into the `users` row when an account is created so a plan
 * change can be rolled out per account without a code deploy.
 */
export type Tier = "hobby" | "professional" | "enterprise";

export type TierDefinition = {
  id: Tier;
  label: string;
  priceMonthlyUsd: number;
  monthlyCredits: number;
  rateLimitPerMinute: number;
  concurrentLimit: number;
  description: string;
};

export const TIERS: Record<Tier, TierDefinition> = {
  hobby: {
    id: "hobby",
    label: "Hobby",
    priceMonthlyUsd: 19,
    monthlyCredits: 5_000,
    rateLimitPerMinute: 30,
    concurrentLimit: 2,
    description: "Small developer projects and evaluation workloads.",
  },
  professional: {
    id: "professional",
    label: "Professional",
    priceMonthlyUsd: 49,
    monthlyCredits: 25_000,
    rateLimitPerMinute: 120,
    concurrentLimit: 8,
    description: "Continuous production tracking and scheduled pipelines.",
  },
  enterprise: {
    id: "enterprise",
    label: "Enterprise",
    priceMonthlyUsd: 149,
    monthlyCredits: 150_000,
    rateLimitPerMinute: 600,
    concurrentLimit: 32,
    description: "Massive concurrent scraping pipelines with priority routing.",
  },
};

export const TIER_LIST: TierDefinition[] = [
  TIERS.hobby,
  TIERS.professional,
  TIERS.enterprise,
];

export function isTier(value: string): value is Tier {
  return value === "hobby" || value === "professional" || value === "enterprise";
}
