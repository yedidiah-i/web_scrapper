"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import ScrappyBrand from "@/app/components/ScrappyBrand";

/** Dashboard sign-in page. */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "Sign in failed.");
        return;
      }

      const next = new URLSearchParams(window.location.search).get("next");
      const destination =
        next?.startsWith("/") && !next.startsWith("//") && !next.includes("\\\\")
          ? next
          : "/dashboard";
      router.replace(destination);
      router.refresh();
    } catch {
      setError("Could not reach the gateway.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-6">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 inline-flex rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
          <ScrappyBrand subtitle="Extraction workspace" size={42} />
        </Link>

        <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Welcome back</h1>
        <p className="mb-6 text-sm text-zinc-500">Sign in to manage keys and usage.</p>

        <form onSubmit={submit} className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
          <label htmlFor="login-email" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Email
          </label>
          <input
            id="login-email"
            autoComplete="email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
          />

          <label htmlFor="login-password" className="mb-1.5 mt-4 block text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Password
          </label>
          <input
            id="login-password"
            autoComplete="current-password"
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
          />

          {error ? (
            <p className="mt-4 rounded-lg border border-rose-800 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="mt-5 w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-500">
          No account yet?{" "}
          <Link href="/signup" className="font-medium text-emerald-400 hover:text-emerald-300">
            Create one free
          </Link>
        </p>

        <p className="mt-3 text-center text-xs text-zinc-600">
          <Link href="/" className="hover:text-zinc-400">
            ← Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}
