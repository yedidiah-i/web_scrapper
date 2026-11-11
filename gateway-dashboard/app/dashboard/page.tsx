"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import DashboardShell from "../components/DashboardShell";
import type { DashboardStats, DashboardUser } from "../components/dashboard-types";

type Session = { user: DashboardUser };

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(async () => {
    try {
      const response = await fetch("/api/stats", { cache: "no-store" });
      if (!response.ok) return;
      setStats((await response.json()) as DashboardStats);
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

  return <DashboardShell user={session.user} stats={stats} onLogout={logout} />;
}
