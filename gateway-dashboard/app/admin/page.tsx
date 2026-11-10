"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type AdminUser = {
  id: number;
  email: string;
  name: string;
  tier: string;
  role: string;
  monthly_credits: number;
  rate_limit_per_minute: number;
  concurrent_limit: number;
  api_key_count: number;
  active_key_count: number;
  requests: number;
  last_login_at: number | null;
  created_at: number;
};

type Payload = {
  users: AdminUser[];
  totals: {
    accounts: number;
    admins: number;
    api_keys: number;
    requests: number;
  };
};

const TIERS = [
  { id: "hobby", label: "Hobby" },
  { id: "professional", label: "Professional" },
  { id: "enterprise", label: "Enterprise" },
];

function formatDate(value: number | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

/**
 * Fetch every account.
 *
 * Lives outside the component so no setState call is reachable from an effect
 * body, and so the initial load and the post-update refresh share it.
 */
async function fetchUsers(): Promise<Payload> {
  const response = await fetch("/api/admin/users", { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }

  if (response.status === 403) {
    throw new Error("This account is not an administrator.");
  }

  if (!response.ok) {
    throw new Error("Could not load the accounts.");
  }

  return (await response.json()) as Payload;
}

/** Admin console: accounts, plans and roles. */
export default function AdminPage() {
  const router = useRouter();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const load = useCallback(async () => {
    try {
      setPayload(await fetchUsers());
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not reach the gateway.",
      );
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function boot() {
      try {
        const fresh = await fetchUsers();
        if (!active) return;
        setPayload(fresh);
      } catch (cause) {
        if (!active) return;
        const reason = cause instanceof Error ? cause.message : "Could not reach the gateway.";

        if (reason === "unauthenticated") {
          router.replace("/login");
          return;
        }

        setError(reason);
      }
    }

    void boot();
    return () => {
      active = false;
    };
  }, [router]);

  async function update(id: number, body: Record<string, unknown>, success: string) {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const result = await response.json();
      if (!response.ok) {
        setError(result?.error?.message ?? "The update failed.");
        return;
      }

      setMessage(success);
      await load();
    } catch {
      setError("Could not reach the gateway.");
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(event: React.FormEvent) {
    event.preventDefault();
    if (!resetFor) return;

    await update(resetFor.id, { password: resetPassword }, "Password reset.");
    setResetFor(null);
    setResetPassword("");
  }

  if (error && !payload) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-6">
        <div className="max-w-sm text-center">
          <p className="text-sm text-rose-300">{error}</p>
          <Link
            href="/dashboard"
            className="mt-4 inline-block text-sm text-emerald-400 hover:text-emerald-300"
          >
            ← Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-6 py-4">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500 font-bold text-zinc-950">
              S
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">Scrapeworks</p>
              <p className="text-[11px] leading-tight text-zinc-500">Admin console</p>
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

      <main className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-50">Accounts</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Manage plans, roles and credentials for every account.
          </p>
        </div>

        {payload ? (
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Accounts" value={String(payload.totals.accounts)} />
            <Stat label="Administrators" value={String(payload.totals.admins)} />
            <Stat label="API keys" value={String(payload.totals.api_keys)} />
            <Stat label="Total requests" value={String(payload.totals.requests)} />
          </section>
        ) : null}

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

        {resetFor ? (
          <form
            onSubmit={submitReset}
            className="rounded-2xl border border-emerald-800 bg-emerald-950/20 p-6"
          >
            <h2 className="text-lg font-semibold text-zinc-100">
              Reset password for {resetFor.email}
            </h2>
            <p className="mb-4 mt-1 text-sm text-zinc-400">
              Their sessions will be signed out. Share the new password securely.
            </p>
            <div className="flex flex-wrap gap-3">
              <input
                type="text"
                required
                value={resetPassword}
                onChange={(event) => setResetPassword(event.target.value)}
                placeholder="New password"
                className="min-w-[240px] flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
              >
                Reset password
              </button>
              <button
                type="button"
                onClick={() => {
                  setResetFor(null);
                  setResetPassword("");
                }}
                className="rounded-lg border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-zinc-500"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-900/80 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-5 py-3 font-semibold">Account</th>
                <th className="px-5 py-3 font-semibold">Plan</th>
                <th className="px-5 py-3 font-semibold">Role</th>
                <th className="px-5 py-3 font-semibold">Usage</th>
                <th className="px-5 py-3 font-semibold">Last seen</th>
                <th className="px-5 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {!payload ? (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-zinc-500">
                    Loading accounts…
                  </td>
                </tr>
              ) : null}
              {payload?.users.map((user) => (
                <tr key={user.id} className="align-middle">
                  <td className="px-5 py-4">
                    <p className="font-medium text-zinc-100">{user.email}</p>
                    <p className="text-xs text-zinc-500">{user.name}</p>
                  </td>
                  <td className="px-5 py-4">
                    <select
                      value={user.tier}
                      disabled={busy}
                      onChange={(event) =>
                        void update(
                          user.id,
                          { tier: event.target.value },
                          `Moved ${user.email} to the ${event.target.value} plan.`,
                        )
                      }
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-emerald-500"
                    >
                      {TIERS.map((tier) => (
                        <option key={tier.id} value={tier.id}>
                          {tier.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-5 py-4">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void update(
                          user.id,
                          { role: user.role === "admin" ? "user" : "admin" },
                          `${user.email} is now ${user.role === "admin" ? "a standard user" : "an administrator"}.`,
                        )
                      }
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                        user.role === "admin"
                          ? "bg-emerald-950 text-emerald-300 hover:bg-emerald-900/50"
                          : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                      }`}
                    >
                      {user.role}
                    </button>
                  </td>
                  <td className="px-5 py-4 text-xs text-zinc-400">
                    <p>{user.requests} requests</p>
                    <p className="text-zinc-500">
                      {user.active_key_count}/{user.api_key_count} keys active
                    </p>
                  </td>
                  <td className="px-5 py-4 text-xs text-zinc-500">
                    {formatDate(user.last_login_at)}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex flex-wrap gap-2">
                      <button
                        disabled={busy}
                        onClick={() => {
                          setResetFor(user);
                          setResetPassword("");
                        }}
                        className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 disabled:opacity-40"
                      >
                        Reset password
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void update(
                            user.id,
                            { revoke_keys: true },
                            `Revoked the API keys of ${user.email}.`,
                          )
                        }
                        className="rounded-lg border border-rose-900 px-3 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-950/50 disabled:opacity-40"
                      >
                        Revoke keys
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-emerald-300">{value}</p>
    </div>
  );
}
