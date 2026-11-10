"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Profile = {
  user: {
    id: number;
    email: string;
    name: string;
    tier: string;
    tier_label: string;
    role: string;
    monthly_credits: number;
    rate_limit_per_minute: number;
    concurrent_limit: number;
  };
};

type SessionRow = {
  id: number;
  created_at: number;
  expires_at: number;
  expired: boolean;
};

function formatDate(value: number): string {
  return new Date(value).toLocaleString();
}

/**
 * Fetch the account and its sessions.
 *
 * Lives outside the component so no setState call is reachable from an effect
 * body, and so both the initial load and the post-save refresh share it.
 */
async function fetchAccount(): Promise<{ profile: Profile; sessions: SessionRow[] }> {
  const [profileResponse, sessionResponse] = await Promise.all([
    fetch("/api/auth/session", { cache: "no-store" }),
    fetch("/api/account/sessions", { cache: "no-store" }),
  ]);

  if (!profileResponse.ok) {
    throw new Error("unauthenticated");
  }

  const profile = (await profileResponse.json()) as Profile;
  const sessions = sessionResponse.ok
    ? (((await sessionResponse.json()) as { sessions: SessionRow[] }).sessions ?? [])
    : [];

  return { profile, sessions };
}

/** Account settings: profile, password and active sessions. */
export default function AccountPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [name, setName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { profile: fresh, sessions: freshSessions } = await fetchAccount();
      setProfile(fresh);
      setName(fresh.user.name);
      setSessions(freshSessions);
    } catch {
      setError("Could not load your account.");
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function boot() {
      try {
        const { profile: fresh, sessions: freshSessions } = await fetchAccount();
        if (!active) return;
        setProfile(fresh);
        setName(fresh.user.name);
        setSessions(freshSessions);
      } catch {
        if (!active) return;
        router.replace("/login");
      }
    }

    void boot();
    return () => {
      active = false;
    };
  }, [router]);

  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "Could not update your name.");
        return;
      }

      setMessage("Name updated.");
      await load();
    } catch {
      setError("Could not reach the gateway.");
    } finally {
      setBusy(false);
    }
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: currentPassword,
          password: newPassword,
        }),
      });

      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "Could not change your password.");
        return;
      }

      setMessage("Password changed. Other sessions were signed out.");
      setCurrentPassword("");
      setNewPassword("");
      await load();
    } catch {
      setError("Could not reach the gateway.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeOthers() {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/account/sessions", { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "Could not sign out other sessions.");
        return;
      }

      setMessage(`Signed out ${body.revoked ?? 0} other session(s).`);
      await load();
    } catch {
      setError("Could not reach the gateway.");
    } finally {
      setBusy(false);
    }
  }

  if (!profile) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Loading account…
      </div>
    );
  }

  const user = profile.user;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-4 px-6 py-4">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500 font-bold text-zinc-950">
              S
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">Scrapeworks</p>
              <p className="text-[11px] leading-tight text-zinc-500">Account settings</p>
            </div>
          </Link>
          <Link
            href="/dashboard"
            className="ml-auto rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
          >
            ← Back to dashboard
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
          <h1 className="text-lg font-semibold text-zinc-100">Your account</h1>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Email</dt>
              <dd className="mt-1 text-sm text-zinc-200">{user.email}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Plan</dt>
              <dd className="mt-1 text-sm text-zinc-200">
                {user.tier_label}
                {user.role === "admin" ? (
                  <span className="ml-2 rounded-full bg-emerald-950 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                    admin
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Monthly credits</dt>
              <dd className="mt-1 text-sm text-zinc-200">
                {user.monthly_credits.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Limits</dt>
              <dd className="mt-1 text-sm text-zinc-200">
                {user.rate_limit_per_minute} req/min · {user.concurrent_limit} concurrent
              </dd>
            </div>
          </dl>
        </section>

        {error ? (
          <p className="rounded-lg border border-rose-800 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
            {message}
          </p>
        ) : null}

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
          <h2 className="text-lg font-semibold text-zinc-100">Display name</h2>
          <p className="mb-4 text-sm text-zinc-500">
            Shown on your account and in the dashboard header.
          </p>
          <form onSubmit={saveName} className="flex flex-wrap gap-3">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="min-w-[220px] flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none focus:border-emerald-500"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
            >
              Save
            </button>
          </form>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
          <h2 className="text-lg font-semibold text-zinc-100">Change password</h2>
          <p className="mb-4 text-sm text-zinc-500">
            Changing your password signs out every other device.
          </p>
          <form onSubmit={savePassword} className="space-y-3">
            <div>
              <label
                htmlFor="current"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-400"
              >
                Current password
              </label>
              <input
                id="current"
                type="password"
                required
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label
                htmlFor="next"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-400"
              >
                New password
              </label>
              <input
                id="next"
                type="password"
                required
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="At least 10 characters"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
            >
              Update password
            </button>
          </form>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">Active sessions</h2>
              <p className="text-sm text-zinc-500">
                Every device currently signed in to this account.
              </p>
            </div>
            <button
              onClick={revokeOthers}
              disabled={busy}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 disabled:opacity-40"
            >
              Sign out other devices
            </button>
          </div>

          <ul className="divide-y divide-zinc-800">
            {sessions.length === 0 ? (
              <li className="py-6 text-center text-sm text-zinc-500">No sessions.</li>
            ) : null}
            {sessions.map((session, index) => (
              <li key={session.id} className="flex flex-wrap items-center gap-4 py-4">
                <div className="min-w-[200px] flex-1">
                  <p className="text-sm font-medium text-zinc-200">
                    {index === 0 ? "Current session" : `Session ${session.id}`}
                  </p>
                  <p className="text-xs text-zinc-500">
                    Started {formatDate(session.created_at)}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    session.expired
                      ? "bg-zinc-800 text-zinc-500"
                      : "bg-emerald-950 text-emerald-300"
                  }`}
                >
                  {session.expired ? "expired" : "active"}
                </span>
                <span className="text-xs text-zinc-500">
                  until {formatDate(session.expires_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
