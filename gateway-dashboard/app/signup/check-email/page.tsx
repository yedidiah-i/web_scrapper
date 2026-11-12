import Link from "next/link";

import ScrappyBrand from "@/app/components/ScrappyBrand";

export default function CheckEmailPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 py-12">
      <section className="w-full max-w-md">
        <Link href="/" className="mb-10 inline-flex rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
          <ScrappyBrand subtitle="Extraction workspace" size={42} />
        </Link>
        <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-7 shadow-xl shadow-black/10">
          <span className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-cyan-950 text-cyan-300" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" className="size-6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h16v12H4z" />
              <path d="m4 7 8 6 8-6" />
            </svg>
          </span>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-400">One last step</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">Check your inbox</h1>
          <p className="mt-3 text-sm leading-6 text-zinc-400">
            If the address can be registered, Scrappy has sent a confirmation link. Open it to verify your email, then sign in to your workspace.
          </p>
          <Link href="/login" className="mt-7 inline-flex w-full items-center justify-center rounded-xl bg-cyan-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-cyan-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950">
            Return to sign in
          </Link>
        </div>
      </section>
    </main>
  );
}
