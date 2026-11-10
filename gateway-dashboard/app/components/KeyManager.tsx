"use client";

import { useCallback, useEffect, useState } from "react";

type ApiKey = {
  id: number;
  label: string;
  masked: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  active: boolean;
};

function formatDate(value: number | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

/**
 * Fetch the API keys of the signed-in account.
 *
 * Lives outside the component so no setState call is reachable from an effect
 * body, and so the initial load and the post-mutation refresh share it.
 */
async function fetchKeys(): Promise<ApiKey[]> {
  const response = await fetch("/api/keys", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Could not load API keys.");
  }

  const body = (await response.json()) as { keys?: ApiKey[] };
  return body.keys ?? [];
}

/**
 * API key hub (Step 5.1).
 *
 * Keys are masked by default. A freshly created or rotated secret is shown
 * exactly once because the server only stores its hash.
 */
export default function KeyManager() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys(await fetchKeys());
    } catch {
      setError("Could not load API keys.");
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function boot() {
      try {
        const fresh = await fetchKeys();
        if (!active) return;
        setKeys(fresh);
      } catch {
        if (!active) return;
        setError("Could not load API keys.");
      }
    }

    void boot();
    return () => {
      active = false;
    };
  }, []);

  async function createKey() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() || "default" }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "Could not create the key.");
        return;
      }
      setSecret({ label: body.label, value: body.secret });
      setLabel("");
      await load();
    } catch {
      setError("Could not create the key.");
    } finally {
      setBusy(false);
    }
  }

  async function rotateKey(id: number) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/keys/${id}`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "Could not rotate the key.");
        return;
      }
      setSecret({ label: body.label, value: body.secret });
      await load();
    } catch {
      setError("Could not rotate the key.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(id: number) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/keys/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json();
        setError(body?.error?.message ?? "Could not revoke the key.");
        return;
      }
      await load();
    } catch {
      setError("Could not revoke the key.");
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.value);
    } catch {
      setError("Clipboard access was blocked. Select the secret manually.");
    }
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">API keys</h2>
          <p className="text-sm text-zinc-500">
            Secrets are stored hashed. A new secret is revealed once, at creation or rotation.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Key label"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
          />
          <button
            onClick={createKey}
            disabled={busy}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            Generate key
          </button>
        </div>
      </div>

      {error ? (
        <p className="mb-4 rounded-lg border border-rose-800 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">
          {error}
        </p>
      ) : null}

      {secret ? (
        <div className="mb-5 rounded-xl border border-emerald-700 bg-emerald-950/40 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-400">
            New secret for “{secret.label}” — copy it now
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <code className="break-all rounded-lg bg-zinc-950 px-3 py-2 font-mono text-xs text-emerald-200">
              {secret.value}
            </code>
            <button
              onClick={copySecret}
              className="rounded-lg border border-emerald-700 px-3 py-2 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-900/40"
            >
              Copy
            </button>
            <button
              onClick={() => setSecret(null)}
              className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
            >
              Hide
            </button>
          </div>
        </div>
      ) : null}

      <ul className="divide-y divide-zinc-800">
        {keys.length === 0 ? (
          <li className="py-6 text-center text-sm text-zinc-500">No API keys yet.</li>
        ) : null}
        {keys.map((key) => (
          <li key={key.id} className="flex flex-wrap items-center gap-4 py-4">
            <div className="min-w-[180px] flex-1">
              <p className="text-sm font-medium text-zinc-200">{key.label}</p>
              <p className="font-mono text-xs text-zinc-500">{key.masked}</p>
            </div>
            <div className="text-xs text-zinc-500">
              <p>Created {formatDate(key.created_at)}</p>
              <p>Last used {formatDate(key.last_used_at)}</p>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                key.active
                  ? "bg-emerald-950 text-emerald-300"
                  : "bg-zinc-800 text-zinc-500 line-through"
              }`}
            >
              {key.active ? "active" : "revoked"}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => rotateKey(key.id)}
                disabled={busy || !key.active}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 disabled:opacity-40"
              >
                Rotate
              </button>
              <button
                onClick={() => revokeKey(key.id)}
                disabled={busy || !key.active}
                className="rounded-lg border border-rose-900 px-3 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-950/50 disabled:opacity-40"
              >
                Revoke
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
