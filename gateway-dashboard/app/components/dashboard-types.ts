export type DashboardUser = {
  id: number;
  email: string;
  name: string;
  tier: string;
  tier_label: string;
  role: string;
  monthly_credits: number;
  credits_used: number;
  credits_remaining: number;
  rate_limit_per_minute: number;
  concurrent_limit: number;
};

export type DashboardStats = {
  usage: {
    requests: number;
    credits_used: number;
    urls_processed: number;
    bytes_out: number;
    succeeded: number;
    failed: number;
    avg_latency_ms: number;
    series: Array<{ ts: number; success: number; failed: number }>;
  };
  credits: {
    monthly_credits: number;
    used: number;
    remaining: number;
    price_monthly_usd: number | null;
  };
  services: {
    engine: { status: string; workers?: number | null; queue_depth?: number | null };
    processor: { status: string };
  };
};

export type DashboardSection = "home" | "scrape-links" | "recents" | "keys" | "usage";

export type RecentRun = {
  id: string;
  urls: string[];
  completedAt: number;
  durationMs: number;
  succeeded: boolean;
  result: unknown;
  error?: string;
};
