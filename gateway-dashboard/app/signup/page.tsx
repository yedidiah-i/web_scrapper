"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

const PASSWORD_RULES = [
  "At least 10 characters",
  "Contains a letter",
  "Contains a number",
];

/** Account creation page. */
export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "Could not create the account.");
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("Could not reach the gateway.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500 font-bold text-zinc-950">
            S
          </div>
          <div>
            <p className="font-semibold text-zinc-100">Scrapeworks</p>
            <p className="text-xs text-zinc-500">Extraction control panel</p>
          </div>
        </Link>

        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-zinc-100">Create your account</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Start on the Hobby plan with 5,000 credits a month.
          </p>
        </div>

        <form
          onSubmit={submit}
          className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6"
        >
          <label
            htmlFor="name"
            className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-400"
          >
            Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Your name"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
          />

          <label
            htmlFor="email"
            className="mb-1.5 mt-4 block text-xs font-semibold uppercase tracking-wide text-zinc-400"
          >
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
          />

          <label
            htmlFor="password"
            className="mb-1.5 mt-4 block text-xs font-semibold uppercase tracking-wide text-zinc-400"
          >
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••••"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
          />

          <ul className="mt-2 space-y-0.5">
            {PASSWORD_RULES.map((rule) => (
              <li key={rule} className="text-[11px] text-zinc-500">
                · {rule}
              </li>
            ))}
          </ul>

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
            {busy ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-500">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-emerald-400 hover:text-emerald-300">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
