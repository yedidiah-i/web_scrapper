"use client";

import { useState, type FormEvent } from "react";

import JsonViewer from "./JsonViewer";
import type { DashboardStats, DashboardUser, RecentRun } from "./dashboard-types";

type Props = {
  user: DashboardUser;
  stats: DashboardStats | null;
  queuedUrls: string[];
  recentRuns: RecentRun[];
  onQueueChange: (urls: string[]) => void;
  onRunComplete: (run: RecentRun) => void;
  onOpenScraper: (urls: string[]) => void;
  onOpenSection: (section: "keys" | "usage" | "recents") => void;
  onOpenRecent: (run: RecentRun) => void;
};

function hostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

export default function DashboardHome({
  user,
  stats,
  queuedUrls,
  recentRuns,
  onQueueChange,
  onRunComplete,
  onOpenScraper,
  onOpenSection,
  onOpenRecent,
}: Props) {
  const [newUrl, setNewUrl] = useState("");
  const [queueError, setQueueError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [latestRun, setLatestRun] = useState<RecentRun | null>(null);

  function addUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = newUrl.trim();
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Choose an http or https link.");
      }
      if (queuedUrls.includes(value)) {
        setQueueError("That link is already in your scrape list.");
        return;
      }
      onQueueChange([...queuedUrls, value]);
      setNewUrl("");
      setQueueError(null);
    } catch (error) {
      setQueueError(error instanceof Error && error.message !== "Invalid URL" ? error.message : "Enter a valid page URL.");
    }
  }

  async function runQueue() {
    if (queuedUrls.length === 0 || running) return;
    setRunning(true);
    setRunError(null);
    const startedAt = Date.now();

    try {
      const response = await fetch("/api/playground", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: queuedUrls, target: "auto", selectors: [] }),
      });
      const result = await response.json();
      const errorMessage = response.ok ? undefined : result?.error?.message ?? "The extraction failed.";
      const run: RecentRun = {
        id: crypto.randomUUID(),
        urls: [...queuedUrls],
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        succeeded: response.ok,
        result,
        error: errorMessage,
      };
      setLatestRun(run);
      onRunComplete(run);
      if (errorMessage) setRunError(errorMessage);
    } catch {
      const run: RecentRun = {
        id: crypto.randomUUID(),
        urls: [...queuedUrls],
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        succeeded: false,
        result: null,
        error: "Could not reach the extraction service.",
      };
      setLatestRun(run);
      onRunComplete(run);
      setRunError(run.error ?? "The extraction failed.");
    } finally {
      setRunning(false);
    }
  }

  const creditPercent = user.monthly_credits > 0
    ? Math.min(100, Math.round((user.credits_remaining / user.monthly_credits) * 100))
    : 0;

  return (
    <div className="min-w-0">
      <section className="mx-auto mb-8 max-w-4xl py-7 text-center sm:py-10">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-white px-3 py-1.5 text-xs font-medium text-zinc-500 shadow-sm">
          <span aria-hidden="true" className="size-2 rounded-full bg-emerald-500" />
          Extraction workspace
        </div>
        <h1 className="text-3xl font-semibold tracking-[-0.045em] text-zinc-100 sm:text-[42px]">
          What would you like to scrape?
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-500 sm:text-base">
          Add pages to your scrape list, run an extraction, and find the response in your recents.
        </p>

        <form onSubmit={addUrl} className="mx-auto mt-7 flex max-w-3xl flex-col gap-2 rounded-2xl border border-zinc-800 bg-white p-2 shadow-[0_8px_30px_rgba(30,40,24,0.06)] sm:flex-row sm:items-center">
          <label htmlFor="dashboard-url" className="sr-only">Page URL to add</label>
          <span aria-hidden="true" className="hidden pl-3 text-zinc-500 sm:block">↗</span>
          <input
            id="dashboard-url"
            type="url"
            value={newUrl}
            onChange={(event) => setNewUrl(event.target.value)}
            placeholder="Paste a page URL to scrape"
            className="min-w-0 flex-1 rounded-xl border border-transparent bg-transparent px-3 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-emerald-700 focus:ring-2 focus:ring-emerald-800/30 sm:px-2"
          />
          <button type="submit" className="rounded-xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-600">
            Add link
          </button>
        </form>
        {queueError ? <p role="alert" className="mt-2 text-left text-xs text-rose-700 sm:mx-auto sm:max-w-3xl">{queueError}</p> : null}
      </section>

      <section aria-label="Workspace overview" className="grid min-w-0 gap-4 lg:grid-cols-3">
        <article className="flex min-w-0 flex-col rounded-2xl border border-zinc-800 bg-white p-5 shadow-[0_2px_12px_rgba(30,40,24,0.035)] sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Scrape links</h2>
              <p className="mt-1 text-xs text-zinc-500">Pages ready for extraction</p>
            </div>
            <span className="rounded-full bg-zinc-800 px-2.5 py-1 text-[11px] font-semibold text-zinc-500">
              {queuedUrls.length} queued
            </span>
          </div>

          {queuedUrls.length ? (
            <ul className="mb-4 flex max-h-56 flex-col gap-2 overflow-y-auto overscroll-contain pr-1">
              {queuedUrls.map((url) => (
                <li key={url} className="flex min-w-0 items-center gap-2 rounded-xl bg-zinc-950/60 px-3 py-2.5">
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-300" title={url}>{hostname(url)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${url}`}
                    onClick={() => onQueueChange(queuedUrls.filter((item) => item !== url))}
                    className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mb-4 flex min-h-32 flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-950/30 px-4 text-center">
              <p className="text-sm font-medium text-zinc-300">Your list is ready</p>
              <p className="mt-1 max-w-[220px] text-xs leading-5 text-zinc-500">Add a URL above and it will appear here before you run it.</p>
            </div>
          )}

          <div className="mt-auto flex flex-col gap-2">
            <button
              type="button"
              onClick={runQueue}
              disabled={!queuedUrls.length || running}
              className="w-full rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {running ? "Extracting pages…" : `Run extraction${queuedUrls.length ? ` · ${queuedUrls.length}` : ""}`}
            </button>
            <button type="button" onClick={() => onOpenScraper(queuedUrls)} className="rounded-xl px-3 py-2 text-xs font-medium text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100">
              Advanced scraper options
            </button>
          </div>
          {runError ? <p role="alert" className="mt-3 text-xs text-rose-700">{runError}</p> : null}
        </article>

        <article className="rounded-2xl border border-zinc-800 bg-white p-5 shadow-[0_2px_12px_rgba(30,40,24,0.035)] sm:p-6">
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-zinc-100">API tools</h2>
            <p className="mt-1 text-xs text-zinc-500">Manage access and monitor your plan</p>
          </div>
          <button type="button" onClick={() => onOpenSection("keys")} className="group mb-3 flex w-full items-center gap-3 rounded-xl border border-zinc-800 p-3 text-left transition hover:border-emerald-700 hover:bg-zinc-950/40">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-xs font-semibold text-zinc-100">API</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-zinc-100">API keys</span>
              <span className="mt-0.5 block text-xs text-zinc-500">Create, rotate, and revoke</span>
            </span>
            <span aria-hidden="true" className="text-zinc-500 transition group-hover:translate-x-0.5">→</span>
          </button>
          <button type="button" onClick={() => onOpenSection("usage")} className="group flex w-full items-center gap-3 rounded-xl border border-zinc-800 p-3 text-left transition hover:border-emerald-700 hover:bg-zinc-950/40">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-xs font-semibold text-zinc-100">CR</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-zinc-100">Usage &amp; credits</span>
              <span className="mt-0.5 block text-xs text-zinc-500">{user.credits_remaining.toLocaleString()} credits remaining</span>
            </span>
            <span aria-hidden="true" className="text-zinc-500 transition group-hover:translate-x-0.5">→</span>
          </button>
          <div className="mt-5 border-t border-zinc-800 pt-4">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="text-zinc-500">Monthly credits</span>
              <span className="font-medium text-zinc-300">{creditPercent}% left</span>
            </div>
            <div role="progressbar" aria-label="Monthly credits remaining" aria-valuemin={0} aria-valuemax={100} aria-valuenow={creditPercent} className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${creditPercent}%` }} />
            </div>
            <p className="mt-2 text-[11px] text-zinc-500">{user.tier_label} plan · {stats?.usage.requests ?? 0} requests in 24h</p>
          </div>
        </article>

        <article className="min-w-0 rounded-2xl border border-zinc-800 bg-white p-5 shadow-[0_2px_12px_rgba(30,40,24,0.035)] sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Recents</h2>
              <p className="mt-1 text-xs text-zinc-500">Runs from this session</p>
            </div>
            <button type="button" onClick={() => onOpenSection("recents")} className="rounded-lg px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100">View all</button>
          </div>
          {recentRuns.length ? (
            <ul className="divide-y divide-zinc-800">
              {recentRuns.slice(0, 5).map((run) => (
                <li key={run.id}>
                  <button type="button" onClick={() => onOpenRecent(run)} className="flex w-full min-w-0 items-center gap-3 py-3 text-left">
                    <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${run.succeeded ? "bg-emerald-500" : "bg-rose-500"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-zinc-100">{hostname(run.urls[0] ?? "Scrape run")}{run.urls.length > 1 ? ` +${run.urls.length - 1}` : ""}</span>
                      <span className="mt-1 block text-[11px] text-zinc-500">{new Date(run.completedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {run.durationMs} ms</span>
                    </span>
                    <span aria-hidden="true" className="text-zinc-500">→</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex min-h-32 flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 px-4 text-center">
              <p className="text-sm font-medium text-zinc-300">Nothing here yet</p>
              <p className="mt-1 max-w-[220px] text-xs leading-5 text-zinc-500">Your completed extractions will show up here.</p>
            </div>
          )}
        </article>
      </section>

      {latestRun ? (
        <section aria-labelledby="latest-response-title" className="mt-4 rounded-2xl border border-zinc-800 bg-white p-5 shadow-[0_2px_12px_rgba(30,40,24,0.035)] sm:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="latest-response-title" className="text-sm font-semibold text-zinc-100">Latest response</h2>
              <p className="mt-1 text-xs text-zinc-500">{latestRun.succeeded ? "Extraction complete" : latestRun.error} · {latestRun.durationMs} ms</p>
            </div>
            <span className="rounded-full bg-zinc-800 px-2.5 py-1 text-[11px] font-medium text-zinc-500">application/json</span>
          </div>
          <JsonViewer value={latestRun.result} maxHeight={360} emptyLabel="No response payload was returned." />
        </section>
      ) : null}

      <section className="mt-4 flex flex-col gap-4 rounded-2xl border border-zinc-800 bg-white p-5 shadow-[0_2px_12px_rgba(30,40,24,0.035)] sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-emerald-700">Build with Scrappy</p>
          <h2 className="mt-1 text-base font-semibold text-zinc-100">Ready to connect your app?</h2>
          <p className="mt-1 text-xs leading-5 text-zinc-500">Create an API key and send your first extraction request.</p>
        </div>
        <button type="button" onClick={() => onOpenSection("keys")} className="shrink-0 rounded-xl border border-zinc-800 px-4 py-2.5 text-xs font-semibold text-zinc-100 transition hover:border-emerald-700 hover:bg-zinc-950/40">
          View API setup <span aria-hidden="true">→</span>
        </button>
      </section>
    </div>
  );
}
