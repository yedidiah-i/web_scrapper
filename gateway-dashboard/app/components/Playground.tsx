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
export default function Playground() {
  const [urls, setUrls] = useState("https://example.com");
  const [target, setTarget] = useState("auto");
  const [selectors, setSelectors] = useState("");
  const [crawlDepth, setCrawlDepth] = useState(0);
  const [label, setLabel] = useState("");
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
          crawl_depth: Number(crawlDepth),
          label: label.trim() || undefined,
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

  const exportUrls = (result as { export_urls?: Record<string, string> } | null)?.export_urls;

  return (
    <section className="grid gap-5 lg:grid-cols-[minmax(300px,380px)_1fr]">
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

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Recursive Crawl
            </label>
            <select
              value={crawlDepth}
              onChange={(e) => setCrawlDepth(Number(e.target.value))}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-emerald-500"
            >
              <option value={0}>0 (Single page)</option>
              <option value={1}>1 (Follow page links)</option>
              <option value={2}>2 (Deep crawl: 2 hops)</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Crawl Label (optional)
            </label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Products audit"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
            />
          </div>
        </div>

        <button
          onClick={run}
          disabled={running}
          className="mt-5 w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
        >
          {running ? "Extracting & Crawling…" : "Run extraction"}
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

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-zinc-100">Response & Exports</h2>
          {exportUrls ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">Download:</span>
              <a
                href={exportUrls.csv}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-zinc-700 hover:text-emerald-200"
              >
                CSV
              </a>
              <a
                href={exportUrls.markdown}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-zinc-700 hover:text-emerald-200"
              >
                Markdown
              </a>
              <a
                href={exportUrls.parquet}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-zinc-700 hover:text-emerald-200"
              >
                Parquet
              </a>
              <a
                href={exportUrls.excel}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-zinc-700 hover:text-emerald-200"
              >
                Excel
              </a>
              {exportUrls.zip ? (
                <a
                  href={exportUrls.zip}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-zinc-700 hover:text-emerald-200"
                >
                  ZIP Bundle
                </a>
              ) : null}
            </div>
          ) : (
            <span className="rounded-full bg-zinc-800 px-2.5 py-1 text-[11px] font-semibold text-zinc-400">
              application/json
            </span>
          )}
        </div>
        <JsonViewer value={result} />
      </div>
    </section>
  );
}
