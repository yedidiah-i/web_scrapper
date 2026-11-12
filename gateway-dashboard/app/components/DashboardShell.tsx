"use client";

import { useMemo, useState } from "react";

import DashboardHome from "./DashboardHome";
import DashboardSidebar from "./DashboardSidebar";
import JsonViewer from "./JsonViewer";
import KeyManager from "./KeyManager";
import Playground from "./Playground";
import UsageChart from "./UsageChart";
import type { DashboardSection, DashboardStats, DashboardUser, RecentRun } from "./dashboard-types";

type Props = {
  user: DashboardUser;
  stats: DashboardStats | null;
  onLogout: () => void;
};

const sectionTitles: Record<DashboardSection, string> = {
  home: "Account home",
  "scrape-links": "Scrape links",
  recents: "Recents",
  keys: "API keys",
  usage: "Usage & credits",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function DashboardShell({ user, stats, onLogout }: Props) {
  const [activeSection, setActiveSection] = useState<DashboardSection>("home");
  const [queuedUrls, setQueuedUrls] = useState<string[]>([]);
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [selectedRecentId, setSelectedRecentId] = useState<string | null>(null);
  const [playgroundUrls, setPlaygroundUrls] = useState("");

  const selectedRecent = useMemo(
    () => recentRuns.find((run) => run.id === selectedRecentId) ?? recentRuns[0] ?? null,
    [recentRuns, selectedRecentId],
  );

  function addRecentRun(run: RecentRun) {
    setRecentRuns((current) => [run, ...current.filter((item) => item.id !== run.id)].slice(0, 20));
    setSelectedRecentId(run.id);
  }

  function openScraper(urls: string[]) {
    setPlaygroundUrls(urls.join("\n"));
    setActiveSection("scrape-links");
  }

  const engineStatus = stats?.services.engine.status ?? "checking";
  const isEngineReady = engineStatus === "ok" || engineStatus === "healthy" || engineStatus === "ready";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 md:grid md:grid-cols-[240px_minmax(0,1fr)]">
      <DashboardSidebar
        activeSection={activeSection}
        onNavigate={setActiveSection}
        onLogout={onLogout}
        user={user}
      />

      <div className="min-w-0">
        <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
          <div className="flex min-h-16 items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-zinc-100">{sectionTitles[activeSection]}</p>
              <p className="hidden text-[11px] text-zinc-500 sm:block">{user.tier_label} workspace</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 sm:gap-4">
              <span className="hidden items-center gap-2 text-xs text-zinc-500 sm:inline-flex">
                <span aria-hidden="true" className={`size-1.5 rounded-full ${isEngineReady ? "bg-emerald-500" : "bg-amber-500"}`} />
                Engine {engineStatus}
              </span>
              <span className="hidden rounded-lg border border-zinc-800 bg-white px-3 py-2 text-xs text-zinc-500 md:inline-flex">
                {user.credits_remaining.toLocaleString()} credits
              </span>
              <button type="button" onClick={onLogout} className="rounded-lg px-3 py-2 text-xs font-medium text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100 md:hidden">
                Sign out
              </button>
            </div>
          </div>
        </header>

        <main className="mx-auto min-w-0 max-w-[1600px] px-4 pb-10 sm:px-6 lg:px-8">
          {activeSection === "home" ? (
            <DashboardHome
              user={user}
              stats={stats}
              queuedUrls={queuedUrls}
              recentRuns={recentRuns}
              onQueueChange={setQueuedUrls}
              onRunComplete={addRecentRun}
              onOpenScraper={openScraper}
              onOpenSection={setActiveSection}
              onOpenRecent={(run) => {
                setSelectedRecentId(run.id);
                setActiveSection("recents");
              }}
            />
          ) : null}

          {activeSection === "scrape-links" ? (
            <section className="min-w-0 py-8">
              <PageHeading title="Scrape links" description="Choose targets, add custom selectors, and inspect the complete extraction response." />
              <Playground key={playgroundUrls} initialUrls={playgroundUrls || "https://example.com"} />
            </section>
          ) : null}

          {activeSection === "recents" ? (
            <section className="min-w-0 py-8">
              <PageHeading title="Recents" description="Review extraction runs from this session and inspect their responses." />
              {recentRuns.length ? (
                <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]">
                  <div className="rounded-2xl border border-zinc-800 bg-white p-4 sm:p-5">
                    <ul className="divide-y divide-zinc-800">
                      {recentRuns.map((run) => (
                        <li key={run.id}>
                          <button type="button" onClick={() => setSelectedRecentId(run.id)} aria-current={selectedRecent?.id === run.id ? "true" : undefined} className={`flex w-full min-w-0 items-start gap-3 rounded-lg px-2 py-3 text-left ${selectedRecent?.id === run.id ? "bg-zinc-800" : "hover:bg-zinc-950/40"}`}>
                            <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-full ${run.succeeded ? "bg-emerald-500" : "bg-rose-500"}`} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium text-zinc-100">{run.urls[0]}{run.urls.length > 1 ? ` +${run.urls.length - 1}` : ""}</span>
                              <span className="mt-1 block text-[11px] text-zinc-500">{new Date(run.completedAt).toLocaleString()} · {run.durationMs} ms</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {selectedRecent ? (
                    <section className="min-w-0 rounded-2xl border border-zinc-800 bg-white p-4 sm:p-5" aria-label="Selected extraction response">
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <h2 className="truncate text-sm font-semibold text-zinc-100">{selectedRecent.urls[0]}</h2>
                          <p className="mt-1 text-xs text-zinc-500">{selectedRecent.succeeded ? "Completed" : selectedRecent.error ?? "Failed"} · {selectedRecent.durationMs} ms</p>
                        </div>
                        <span className="rounded-full bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-500">{selectedRecent.urls.length} {selectedRecent.urls.length === 1 ? "link" : "links"}</span>
                      </div>
                      <JsonViewer value={selectedRecent.result} maxHeight={560} emptyLabel="No response payload was returned." />
                    </section>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-zinc-800 bg-white px-6 py-16 text-center">
                  <h2 className="text-base font-semibold text-zinc-100">Your recents will appear here</h2>
                  <p className="mt-2 text-sm text-zinc-500">Add a link and run an extraction to start your session history.</p>
                  <button type="button" onClick={() => setActiveSection("home")} className="mt-5 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-600">Go to account home</button>
                </div>
              )}
            </section>
          ) : null}

          {activeSection === "keys" ? (
            <section className="min-w-0 py-8">
              <PageHeading title="API keys" description="Control the credentials your apps use to access the extraction API." />
              <div className="flex min-w-0 flex-col gap-4">
                <KeyManager />
                <section className="min-w-0 rounded-2xl border border-zinc-800 bg-white p-5 sm:p-6">
                  <div className="mb-4">
                    <h2 className="text-sm font-semibold text-zinc-100">Make an extraction request</h2>
                    <p className="mt-1 text-xs text-zinc-500">Use a generated key in the Authorization header.</p>
                  </div>
                  <pre role="region" aria-label="Scrollable API request example" tabIndex={0} className="w-full min-w-0 max-w-full overscroll-contain overflow-auto rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 font-mono text-xs leading-relaxed text-zinc-300">{`curl -X POST ${typeof window === "undefined" ? "" : window.location.origin}/api/v1/extract \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"urls":["https://example.com"],"target":"auto"}'`}</pre>
                </section>
              </div>
            </section>
          ) : null}

          {activeSection === "usage" ? (
            <section className="min-w-0 py-8">
              <PageHeading title="Usage & credits" description="Track request volume, extraction performance, and your monthly allowance." />
              <section className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Credits remaining" value={user.credits_remaining.toLocaleString()} hint={`of ${user.monthly_credits.toLocaleString()} monthly`} />
                <MetricCard label="Requests" value={String(stats?.usage.requests ?? 0)} hint={`${stats?.usage.succeeded ?? 0} succeeded · ${stats?.usage.failed ?? 0} failed`} />
                <MetricCard label="Pages processed" value={String(stats?.usage.urls_processed ?? 0)} hint={`${formatBytes(stats?.usage.bytes_out ?? 0)} returned`} />
                <MetricCard label="Average latency" value={`${stats?.usage.avg_latency_ms ?? 0} ms`} hint={`Engine ${stats?.services.engine.status ?? "checking"}`} />
              </section>
              <section className="mb-4 rounded-2xl border border-zinc-800 bg-white p-5 sm:p-6">
                <h2 className="text-sm font-semibold text-zinc-100">Requests over time</h2>
                <p className="mb-4 mt-1 text-xs text-zinc-500">Successful runs compared with failed requests, bucketed by hour.</p>
                <UsageChart series={stats?.usage.series ?? []} />
              </section>
              <section className="rounded-2xl border border-zinc-800 bg-white p-5 sm:p-6">
                <h2 className="mb-4 text-sm font-semibold text-zinc-100">Usage details</h2>
                <JsonViewer value={stats?.usage ?? null} maxHeight={320} emptyLabel="Usage data is not available yet." />
              </section>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function PageHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-6">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-700">Workspace</p>
      <h1 className="text-2xl font-semibold tracking-[-0.035em] text-zinc-100 sm:text-3xl">{title}</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">{description}</p>
    </div>
  );
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <article className="rounded-2xl border border-zinc-800 bg-white p-4 sm:p-5">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">{value}</p>
      <p className="mt-1 text-xs text-zinc-500">{hint}</p>
    </article>
  );
}
