"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import JsonViewer from "../components/JsonViewer";
import KeyManager from "../components/KeyManager";
import Playground from "../components/Playground";
import UsageChart from "../components/UsageChart";
import HistoryViewer from "../components/HistoryViewer";

type Session = {
  user: {
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
};

type Stats = {
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

type Tab = "playground" | "history" | "keys" | "usage";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Management dashboard (Step 5). */
export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tab, setTab] = useState<Tab>("playground");
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(async () => {
    try {
      const response = await fetch("/api/stats", { cache: "no-store" });
      if (!response.ok) return;
      setStats((await response.json()) as Stats);
    } catch {
      /* keep the last known snapshot */
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function boot() {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (!response.ok) {
          if (active) router.replace("/login");
          return;
        }
        const body = (await response.json()) as Session;
        if (!active) return;
        setSession(body);
        await loadStats();
      } finally {
        if (active) setLoading(false);
      }
    }

    void boot();
    return () => {
      active = false;
    };
  }, [loadStats, router]);

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      void loadStats();
    }, 15_000);
    return () => clearInterval(timer);
  }, [session, loadStats]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Loading workspace…
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Redirecting to sign in…
      </div>
    );
  }

  const user = session.user;
  const creditPercent = user.monthly_credits
    ? Math.round((user.credits_remaining / user.monthly_credits) * 100)
    : 0;

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "playground", label: "Playground" },
    { id: "history", label: "Crawl History" },
    { id: "keys", label: "API keys" },
    { id: "usage", label: "Usage" },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-6 py-4">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500 font-bold text-zinc-950">
              S
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">Scrapeworks</p>
              <p className="text-[11px] leading-tight text-zinc-500">
                Extraction control panel
              </p>
            </div>
          </Link>

          <div className="ml-auto flex flex-wrap items-center gap-4">
            <div className="hidden text-right sm:block">
              <p className="text-xs font-medium text-zinc-300">{user.email}</p>
              <p className="text-[11px] text-zinc-500">
                {user.tier_label} tier · {user.rate_limit_per_minute} req/min ·{" "}
                {user.concurrent_limit} concurrent
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-1.5 text-right">
              <p className="text-[11px] text-zinc-500">Credits left</p>
              <p className="text-sm font-semibold text-emerald-300">
                {user.credits_remaining.toLocaleString()}
                <span className="text-zinc-600">
                  {" "}
                  / {user.monthly_credits.toLocaleString()}
                </span>
              </p>
            </div>
            <Link
              href="/account"
              className="rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
            >
              Account
            </Link>
            {user.role === "admin" ? (
              <Link
                href="/admin"
                className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-xs font-medium text-emerald-300 transition hover:bg-emerald-900/40"
              >
                Admin
              </Link>
            ) : null}
            <button
              onClick={logout}
              className="rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <nav className="mb-6 flex gap-1 border-b border-zinc-800">
          {tabs.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition ${
                tab === item.id
                  ? "border-emerald-400 text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {tab === "playground" ? <Playground /> : null}
        {tab === "history" ? <HistoryViewer /> : null}

        {tab === "keys" ? (
          <div className="space-y-5">
            <KeyManager />
            <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
              <h2 className="mb-3 text-lg font-semibold text-zinc-100">Calling the API</h2>
              <pre className="overflow-auto rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 font-mono text-xs leading-relaxed text-zinc-300">
{`curl -X POST ${typeof window === "undefined" ? "" : window.location.origin}/api/v1/extract \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"urls":["https://example.com"],"target":"tables"}'`}
              </pre>
            </section>
          </div>
        ) : null}

        {tab === "usage" ? (
          <div className="space-y-5">
            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card
                label="Remaining credits"
                value={user.credits_remaining.toLocaleString()}
                hint={`${creditPercent}% of ${user.monthly_credits.toLocaleString()} monthly`}
                accent="emerald"
              />
              <Card
                label="Requests (24h)"
                value={String(stats?.usage.requests ?? 0)}
                hint={`${stats?.usage.succeeded ?? 0} ok · ${stats?.usage.failed ?? 0} failed`}
                accent="sky"
              />
              <Card
                label="Bandwidth out (24h)"
                value={formatBytes(stats?.usage.bytes_out ?? 0)}
                hint={`${stats?.usage.urls_processed ?? 0} urls processed`}
                accent="violet"
              />
              <Card
                label="Avg latency"
                value={`${stats?.usage.avg_latency_ms ?? 0} ms`}
                hint={`engine ${stats?.services.engine.status ?? "?"} · processor ${stats?.services.processor.status ?? "?"}`}
                accent="amber"
              />
            </section>

            <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
              <h2 className="text-lg font-semibold text-zinc-100">Runs over time</h2>
              <p className="mb-4 text-sm text-zinc-500">
                Successful runs against failed network requests, bucketed per hour.
              </p>
              <UsageChart series={stats?.usage.series ?? []} />
            </section>

            <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
              <h2 className="mb-4 text-lg font-semibold text-zinc-100">Raw usage ledger</h2>
              <JsonViewer value={stats?.usage ?? null} maxHeight={320} />
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function Card({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent: "emerald" | "sky" | "violet" | "amber";
}) {
  const tones = {
    emerald: "text-emerald-300",
    sky: "text-sky-300",
    violet: "text-violet-300",
    amber: "text-amber-300",
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${tones[accent]}`}>{value}</p>
      <p className="mt-1 text-xs text-zinc-500">{hint}</p>
    </div>
  );
}
