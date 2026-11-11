import type { Metadata } from "next";
import "./globals.css";
import {GeistSans} from "geist/font/sans"
import {GeistMono} from "geist/font/mono"

export const metadata: Metadata = {
  title: "Scrapeworks · Extraction Control Panel",
  description:
    "High-concurrency scraping API — dashboard for API keys, playground and usage analytics.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">{children}</body>
    </html>
  );
}
