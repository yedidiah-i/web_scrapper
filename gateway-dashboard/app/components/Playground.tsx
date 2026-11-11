"use client";

import { useState } from "react";

import JsonViewer from "./JsonViewer";

const TARGETS = [
  { value: "auto", label: "Auto detect" },
  { value: "text", label: "Article text" },
  { value: "tables", label: "Table entries" },
  { value: "prices", label: "Prices" },
  { value: "images", label: "Images" },
  { value: "links", label: "Links" },
  { value: "metadata", label: "Metadata tags" },
];

/**
 * Interactive playground sandbox (Step 5.2).
 *
 * Control panel on the left, live JSON payload on the right.
 */
export default function Playground({ initialUrls = "https://example.com" }: { initialUrls?: string }) {
  const [urls, setUrls] = useState(initialUrls);
  const [target, setTarget] = useState("auto");
  const [selectors, setSelectors] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    setDuration(null);

    const startedAt = Date.now();

    try {
      const response = await fetch("/api/playground", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: urls.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean),
          target,
          selectors: selectors.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean),
        }),
      });

      const body = await response.json();

      if (!response.ok) {
        setError(body?.error?.message ?? "The extraction failed.");
        setResult(body);
        return;
      }

      setResult(body);
      setDuration(Date.now() - startedAt);
    } catch {
      setError("Could not reach the extraction service.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="grid min-w-0 gap-5 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
        <h2 className="text-lg font-semibold text-zinc-100">Playground</h2>
        <p className="mb-5 text-sm text-zinc-500">
          Run an extraction against the live Rust engine and Python pipeline.
        </p>

        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Target URLs
        </label>
        <textarea
          value={urls}
          onChange={(event) => setUrls(event.target.value)}
          rows={4}
          spellCheck={false}
          className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
        />

        <label className="mb-1.5 mt-4 block text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Extraction target
        </label>
        <select
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-500"
        >
          {TARGETS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="mb-1.5 mt-4 block text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Custom CSS selectors (optional)
        </label>
        <input
          value={selectors}
          onChange={(event) => setSelectors(event.target.value)}
          placeholder=".price, article h2"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
        />

        <button
          onClick={run}
          disabled={running}
          className="mt-5 w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
        >
          {running ? "Extracting…" : "Run extraction"}
        </button>

        {error ? (
          <p className="mt-4 rounded-lg border border-rose-800 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">
            {error}
          </p>
        ) : null}

        {duration !== null ? (
          <p className="mt-3 text-xs text-zinc-500">Completed in {duration} ms</p>
        ) : null}
      </div>

      <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-zinc-100">Response payload</h2>
          <span className="rounded-full bg-zinc-800 px-2.5 py-1 text-[11px] font-semibold text-zinc-400">
            application/json
          </span>
        </div>
        <JsonViewer value={result} />
      </div>
    </section>
  );
}
