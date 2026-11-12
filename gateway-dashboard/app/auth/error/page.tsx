import Link from "next/link";

import ScrappyBrand from "@/app/components/ScrappyBrand";

export default function AuthErrorPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 py-12">
      <section className="w-full max-w-md">
        <Link href="/" className="mb-10 inline-flex rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
          <ScrappyBrand subtitle="Extraction workspace" size={42} />
        </Link>
        <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-7">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-rose-400">Sign-in link expired</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">We couldn&apos;t verify that link</h1>
          <p className="mt-3 text-sm leading-6 text-zinc-400">Request a new confirmation email and open the latest link to finish signing in.</p>
          <Link href="/signup" className="mt-7 inline-flex w-full items-center justify-center rounded-xl bg-cyan-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-cyan-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950">
            Create an account
          </Link>
        </div>
      </section>
    </main>
  );
}
