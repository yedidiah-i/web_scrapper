import Link from "next/link";

import ScrappyBrand from "@/app/components/ScrappyBrand";
import { cacheLife } from "next/cache";

/**
 * The current year, for the footer.
 *
 * Cached so the landing page can be prerendered as a static shell: without
 * the cache the build treats `new Date()` as an unstable value.
 */
async function currentYear(): Promise<number> {
  "use cache";
  cacheLife("max");
  return new Date().getFullYear();
}

const FEATURES = [
  {
    title: "High-concurrency extraction",
    body: "Jobs are queued across a Rust core worker pool, so a hundred URLs cost you one request and finish in parallel.",
  },
  {
    title: "Structured output",
    body: "Pull tables, prices, links, images or metadata and get clean, typed JSON back — not raw HTML.",
  },
  {
    title: "Keys you control",
    body: "Generate, rotate and revoke API keys from the dashboard. Secrets are hashed and shown exactly once.",
  },
  {
    title: "Usage you can audit",
    body: "Every request is metered into a ledger with latency, bandwidth and credit spend per run.",
  },
];

const PLANS = [
  {
    id: "hobby",
    name: "Hobby",
    price: "$19",
    credits: "5,000 credits",
    rate: "30 req/min",
    features: ["2 concurrent jobs", "Community support"],
  },
  {
    id: "professional",
    name: "Professional",
    price: "$49",
    credits: "25,000 credits",
    rate: "120 req/min",
    features: ["8 concurrent jobs", "Priority routing"],
    highlight: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "$149",
    credits: "150,000 credits",
    rate: "600 req/min",
    features: ["32 concurrent jobs", "Dedicated support"],
  },
];

const CODE_SAMPLE = `curl -X POST https://your-deployed-domain.com/api/v1/extract \\
  -H "Authorization: Bearer sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "urls": ["https://example.com/products"],
    "target": "tables",
    "selectors": [".price", ".sku"]
  }'`;

/**
 * Public landing page.
 *
 * This is what a visitor sees before they have an account. It links to the
 * signup and login pages; the dashboard itself lives behind a session.
 */
export default async function LandingPage() {
  const year = await currentYear();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-20 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
          <Link href="/" className="flex shrink-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
            <ScrappyBrand subtitle="Web extraction workspace" size={38} />
          </Link>

          <nav aria-label="Main navigation" className="ml-auto flex shrink-0 items-center gap-1 sm:gap-3">
            <Link
              href="/login"
              className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-300 transition hover:text-zinc-100"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400"
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-6 pb-16 pt-24 text-center sm:pt-28">
          <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-3.5 py-1.5 text-xs font-medium text-zinc-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Powered by a Rust core and a Python data pipeline
          </p>

          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl lg:text-6xl">
            Scrape any site into{" "}
            <span className="text-emerald-400">clean, structured JSON</span>
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-zinc-400 sm:text-lg">
            One API for high-concurrency extraction. Point it at a page, choose a
            target, and get tables, prices or metadata back in seconds — with
            credits, rate limits and usage reporting built in.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/signup"
              className="rounded-lg bg-emerald-500 px-6 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400"
            >
              Create your account
            </Link>
            <Link
              href="/login"
              className="rounded-lg border border-zinc-700 px-6 py-3 text-sm font-semibold text-zinc-200 transition hover:border-zinc-500"
            >
              Sign in
            </Link>
          </div>

          <p className="mt-4 text-xs text-zinc-500">
            Hobby plan is free to start · 5,000 credits a month · no card needed
          </p>
        </section>

        {/* Code sample */}
        <section className="mx-auto max-w-4xl px-6 pb-20">
          <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
              <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
              <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
              <span className="ml-2 text-xs font-medium text-zinc-500">
                extract.sh
              </span>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-relaxed text-zinc-300">
              {CODE_SAMPLE}
            </pre>
          </div>
        </section>

        {/* Features */}
        <section className="border-y border-zinc-800/80 bg-zinc-900/30">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <h2 className="text-center text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl">
              Everything you need to ship scraping
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-center text-sm text-zinc-500">
              A control panel, a metered API and usage reporting in one product.
            </p>

            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map((feature) => (
                <div
                  key={feature.title}
                  className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6"
                >
                  <h3 className="text-sm font-semibold text-zinc-100">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-500">
                    {feature.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-center text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl">
            Simple pricing
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-sm text-zinc-500">
            Every plan includes the full API, the playground and usage analytics.
          </p>

          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {PLANS.map((plan) => (
              <div
                key={plan.id}
                className={`relative rounded-2xl border p-6 ${
                  plan.highlight
                    ? "border-emerald-600 bg-zinc-900/80"
                    : "border-zinc-800 bg-zinc-900/40"
                }`}
              >
                {plan.highlight ? (
                  <span className="absolute right-5 top-5 rounded-full bg-emerald-500 px-2.5 py-1 text-[11px] font-semibold text-zinc-950">
                    Popular
                  </span>
                ) : null}

                <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
                  {plan.name}
                </h3>
                <p className="mt-3 text-3xl font-semibold text-zinc-50">
                  {plan.price}
                  <span className="text-sm font-normal text-zinc-500"> / month</span>
                </p>

                <ul className="mt-5 space-y-2 text-sm text-zinc-400">
                  <li className="flex items-center gap-2">
                    <span className="text-emerald-400">✓</span> {plan.credits}
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="text-emerald-400">✓</span> {plan.rate}
                  </li>
                  {plan.features.map((item) => (
                    <li key={item} className="flex items-center gap-2">
                      <span className="text-emerald-400">✓</span> {item}
                    </li>
                  ))}
                </ul>

                <Link
                  href="/signup"
                  className={`mt-6 block rounded-lg px-4 py-2.5 text-center text-sm font-semibold transition ${
                    plan.highlight
                      ? "bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
                      : "border border-zinc-700 text-zinc-200 hover:border-zinc-500"
                  }`}
                >
                  Start free
                </Link>
              </div>
            ))}
          </div>
        </section>

        {/* Closing CTA */}
        <section className="border-t border-zinc-800/80 bg-zinc-900/30">
          <div className="mx-auto max-w-3xl px-6 py-20 text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl">
              Ready to pull your first page?
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-sm text-zinc-500">
              Create an account and run your first extraction in the playground
              within a minute.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link
                href="/signup"
                className="rounded-lg bg-emerald-500 px-6 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400"
              >
                Get started free
              </Link>
              <Link
                href="/login"
                className="rounded-lg border border-zinc-700 px-6 py-3 text-sm font-semibold text-zinc-200 transition hover:border-zinc-500"
              >
                Sign in
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-800/80">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-xs text-zinc-500">
          <p>© {year} Scrappy. Web extraction workspace.</p>
          <div className="flex gap-5">
            <Link href="/login" className="hover:text-zinc-300">
              Sign in
            </Link>
            <Link href="/signup" className="hover:text-zinc-300">
              Create account
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
