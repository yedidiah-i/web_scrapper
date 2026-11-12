"use client";

import Link from "next/link";

import ScrappyBrand from "./ScrappyBrand";
import type { DashboardSection, DashboardUser } from "./dashboard-types";

type Props = {
  activeSection: DashboardSection;
  onNavigate: (section: DashboardSection) => void;
  onLogout: () => void;
  user: DashboardUser;
};

const workspaceLinks: Array<{ id: DashboardSection; label: string; icon: string }> = [
  { id: "home", label: "Account home", icon: "home" },
  { id: "scrape-links", label: "Scrape links", icon: "link" },
  { id: "recents", label: "Recents", icon: "clock" },
];

const toolLinks: Array<{ id: DashboardSection; label: string; icon: string }> = [
  { id: "keys", label: "API keys", icon: "key" },
  { id: "usage", label: "Usage & credits", icon: "chart" },
];

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    home: "M3 10.5 12 3l9 7.5M5.5 9v11h13V9M9 20v-6h6v6",
    link: "M10 13a5 5 0 0 0 7.07 0l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15M14 11a5 5 0 0 0-7.07 0l-2 2A5 5 0 0 0 12 20.07l1.15-1.15",
    clock: "M3 12a9 9 0 1 0 2.64-6.36L3 8m0-5v5h5m4-1v5l3 2",
    key: "M15.5 8.5a4.5 4.5 0 1 1-8.74 1.5A4.5 4.5 0 0 1 15.5 8.5ZM12 12l8 8m-3-3 2-2m-5-1 2-2",
    chart: "M4 19V5m0 14h17M7 15l4-4 3 2 5-7",
  };

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="size-[18px] shrink-0" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name] ?? paths.home} />
    </svg>
  );
}

function NavButton({
  item,
  active,
  onClick,
}: {
  item: { id: DashboardSection; label: string; icon: string };
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`flex min-w-max items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition md:w-full ${
        active
          ? "bg-zinc-800 text-zinc-100 shadow-sm"
          : "text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-100"
      }`}
    >
      <NavIcon name={item.icon} />
      <span>{item.label}</span>
    </button>
  );
}

export default function DashboardSidebar({ activeSection, onNavigate, onLogout, user }: Props) {
  return (
    <aside className="z-20 flex min-w-0 flex-col border-b border-zinc-800 bg-white md:sticky md:top-0 md:h-screen md:border-b-0 md:border-r">
      <div className="px-5 py-4 md:border-b md:border-zinc-800 md:px-6 md:py-5">
        <ScrappyBrand subtitle="Extraction workspace" size={38} />
      </div>

      <nav aria-label="Main navigation" className="flex gap-1 overflow-x-auto px-3 py-2 md:flex-1 md:flex-col md:overflow-visible md:px-4 md:py-6">
        <p className="hidden px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500 md:block">
          Workspace
        </p>
        {workspaceLinks.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={activeSection === item.id}
            onClick={() => onNavigate(item.id)}
          />
        ))}
        <p className="hidden px-3 pb-2 pt-7 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500 md:block">
          Build
        </p>
        {toolLinks.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={activeSection === item.id}
            onClick={() => onNavigate(item.id)}
          />
        ))}
      </nav>

      <div className="hidden border-t border-zinc-800 p-4 md:block">
        <div className="mb-3 flex items-center gap-3 rounded-xl px-2 py-2">
          <span className="flex size-9 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-100" aria-hidden="true">
            {user.name.trim().slice(0, 1).toUpperCase() || "?"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-zinc-100">{user.name}</p>
            <p className="truncate text-[11px] text-zinc-500">{user.email}</p>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Link href="/account" className="rounded-lg px-3 py-2 text-xs font-medium text-zinc-500 transition hover:bg-zinc-800/60 hover:text-zinc-100">
            Manage account
          </Link>
          {user.role === "admin" ? (
            <Link href="/admin" className="rounded-lg px-3 py-2 text-xs font-medium text-zinc-500 transition hover:bg-zinc-800/60 hover:text-zinc-100">
              Admin console
            </Link>
          ) : null}
          <button type="button" onClick={onLogout} className="rounded-lg px-3 py-2 text-left text-xs font-medium text-zinc-500 transition hover:bg-zinc-800/60 hover:text-zinc-100">
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
