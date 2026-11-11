"use client";

import { Fragment, useEffect, useState } from "react";

type HistoryEntry = {
  id: number;
  job_id: string;
  label: string | null;
  urls_seed: string[];
  target: string;
  crawl_depth: number;
  succeeded: number;
  failed: number;
  total_pages: number;
  created_at: number;
  updated_at: number;
};

type HistoryResponse = {
  total: number;
  limit: number;
  offset: number;
  entries: HistoryEntry[];
};

type CrawlPage = {
  url: string;
  source_url: string | null;
  depth: number;
  status: string;
  ok: number;
  status_code: number | null;
  engine: string;
  challenge: string | null;
  elapsed_ms: number;
  row_count: number;
  created_at: number;
};

export default function HistoryViewer() {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pages, setPages] = useState<Record<string, CrawlPage[]>>({});
  const [loadingPages, setLoadingPages] = useState<string | null>(null);

  async function loadHistory() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/history?limit=50", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Failed to load history (${res.status})`);
      }
      const json = (await res.json()) as HistoryResponse;
      setData(json);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadHistory();
  }, []);

  async function togglePages(jobId: string) {
    if (expanded === jobId) {
      setExpanded(null);
      return;
    }
    setExpanded(jobId);
    if (pages[jobId]) return;

    setLoadingPages(jobId);
    try {
      const res = await fetch(`/api/history/${jobId}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load pages (${res.status})`);
      const json = (await res.json()) as { pages?: CrawlPage[] };
      setPages((current) => ({ ...current, [jobId]: json.pages ?? [] }));
    } catch {
      setPages((current) => ({ ...current, [jobId]: [] }));
    } finally {
      setLoadingPages(null);
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center text-sm text-zinc-500">
        Loading crawl history…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-rose-900 bg-rose-950/40 p-6 text-sm text-rose-300">
        <p className="font-semibold">Unable to load history</p>
        <p className="mt-1 text-xs text-rose-400">{error}</p>
        <button
          onClick={loadHistory}
          className="mt-3 rounded-lg border border-rose-800 bg-rose-900/50 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-800"
        >
          Retry
        </button>
      </div>
    );
  }

  const entries = data?.entries ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Crawl History</h2>
          <p className="text-sm text-zinc-500">
            Persistent archive of previous crawls with minimal memory consumption.
          </p>
        </div>
        <button
          onClick={loadHistory}
          className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
        >
          Refresh
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-12 text-center text-sm text-zinc-500">
          No previous crawls found. Run an extraction in the Playground or via the API to see history entries here.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-zinc-800 bg-zinc-900/60">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-zinc-800 bg-zinc-950/60 text-zinc-400">
              <tr>
                <th className="px-4 py-3 font-semibold uppercase tracking-wider">Date</th>
                <th className="px-4 py-3 font-semibold uppercase tracking-wider">Label / Job ID</th>
                <th className="px-4 py-3 font-semibold uppercase tracking-wider">Seed URL(s)</th>
                <th className="px-4 py-3 font-semibold uppercase tracking-wider">Target</th>
                <th className="px-4 py-3 font-semibold uppercase tracking-wider">Depth</th>
                <th className="px-4 py-3 font-semibold uppercase tracking-wider">Pages</th>
                <th className="px-4 py-3 font-semibold uppercase tracking-wider">Exports</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
              {entries.map((entry) => {
                const date = new Date(entry.created_at * 1000).toLocaleString();
                const processorUrl =
                  process.env.NEXT_PUBLIC_PROCESSOR_URL || "http://127.0.0.1:59082";
                const baseExport = `${processorUrl}/results/${entry.job_id}`;

                return (
                  <Fragment key={entry.id}>
                  <tr className="hover:bg-zinc-800/30">
                    <td className="whitespace-nowrap px-4 py-3 text-zinc-500">{date}</td>
                    <td className="px-4 py-3">
                      {entry.label ? (
                        <span className="font-semibold text-emerald-400">{entry.label}</span>
                      ) : (
                        <span className="font-mono text-zinc-400">{entry.job_id.slice(0, 8)}…</span>
                      )}
                      <p className="font-mono text-[10px] text-zinc-500">{entry.job_id}</p>
                      <button
                        onClick={() => void togglePages(entry.job_id)}
                        className="mt-1 text-[10px] text-indigo-400 hover:text-indigo-300"
                      >
                        {expanded === entry.job_id ? "Hide page trail" : "Show page trail"}
                      </button>
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 font-mono text-zinc-400">
                      {entry.urls_seed.length > 0 ? entry.urls_seed.join(", ") : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                        {entry.target}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {entry.crawl_depth > 0 ? (
                        <span className="rounded bg-indigo-950/60 px-2 py-0.5 text-[11px] font-medium text-indigo-300">
                          Depth {entry.crawl_depth}
                        </span>
                      ) : (
                        <span className="text-zinc-500">Single</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-emerald-400 font-semibold">{entry.succeeded} ok</span>
                      {entry.failed > 0 && (
                        <span className="text-rose-400 ml-1.5">({entry.failed} err)</span>
                      )}
                      <span className="text-zinc-500 text-[11px] block">
                        {entry.total_pages} total
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <a
                          href={`${baseExport}/csv`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300"
                          title="Download CSV"
                        >
                          CSV
                        </a>
                        <a
                          href={`${baseExport}/markdown`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300"
                          title="Download Markdown"
                        >
                          MD
                        </a>
                        <a
                          href={`${baseExport}/parquet`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300"
                          title="Download Parquet"
                        >
                          Parquet
                        </a>
                        <a
                          href={`${baseExport}/excel`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300"
                          title="Download Excel (.xlsx)"
                        >
                          Excel
                        </a>
                        <a
                          href={`${baseExport}/zip`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300"
                          title="Download Complete ZIP Bundle"
                        >
                          ZIP
                        </a>
                        <a
                          href={`${baseExport}?format=ndjson`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300"
                          title="Download NDJSON (one JSON record per line)"
                        >
                          NDJSON
                        </a>
                      </div>
                    </td>
                  </tr>
                  {expanded === entry.job_id && (
                    <tr>
                      <td colSpan={7} className="bg-zinc-950/60 px-4 py-3">
                        {loadingPages === entry.job_id ? (
                          <p className="text-[11px] text-zinc-500">Loading page trail…</p>
                        ) : (pages[entry.job_id] ?? []).length === 0 ? (
                          <p className="text-[11px] text-zinc-500">
                            No page trail recorded for this crawl.
                          </p>
                        ) : (
                          <table className="w-full text-left text-[11px] text-zinc-400">
                            <thead className="text-zinc-500">
                              <tr>
                                <th className="py-1 pr-3 font-medium">URL</th>
                                <th className="py-1 pr-3 font-medium">Depth</th>
                                <th className="py-1 pr-3 font-medium">Status</th>
                                <th className="py-1 pr-3 font-medium">Engine</th>
                                <th className="py-1 pr-3 font-medium">Rows</th>
                                <th className="py-1 font-medium">Challenge</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(pages[entry.job_id] ?? []).map((page, index) => (
                                <tr key={`${page.url}-${index}`} className="border-t border-zinc-800/60">
                                  <td className="py-1 pr-3 font-mono truncate max-w-md">{page.url}</td>
                                  <td className="py-1 pr-3">{page.depth}</td>
                                  <td className="py-1 pr-3">
                                    <span className={page.ok ? "text-emerald-400" : "text-rose-400"}>
                                      {page.status_code ?? page.status}
                                    </span>
                                  </td>
                                  <td className="py-1 pr-3">{page.engine}</td>
                                  <td className="py-1 pr-3">{page.row_count}</td>
                                  <td className="py-1">{page.challenge || "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
