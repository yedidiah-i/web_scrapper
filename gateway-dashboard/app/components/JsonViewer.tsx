"use client";

import { useMemo } from "react";

type Props = {
  value: unknown;
  emptyLabel?: string;
  maxHeight?: number;
};

const TOKEN =
  /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|(-?\b\d+(?:\.\d+)?\b)|\b(true|false|null)\b/g;

function tokenClass(match: string): string {
  if (match.endsWith(":")) return "text-sky-700";
  if (match.startsWith('"')) return "text-emerald-700";
  if (match === "true" || match === "false" || match === "null") return "text-violet-700";
  return "text-amber-700";
}

/**
 * Syntax highlighted JSON viewer.
 *
 * Renders the payload line by line and colours keys, strings, numbers and
 * literals so the playground output is readable at a glance.
 */
export default function JsonViewer({ value, emptyLabel, maxHeight = 520 }: Props) {
  const text = useMemo(() => {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);

  if (!text) {
    return (
      <div className="flex h-full min-h-[220px] items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-8 text-center text-sm text-zinc-500">
        {emptyLabel ?? "Run a request to see the JSON payload."}
      </div>
    );
  }

  const lines = text.split("\n");

  return (
    <div
      role="region"
      aria-label="Scrollable JSON response"
      tabIndex={0}
      className="w-full min-w-0 max-w-full overscroll-contain overflow-auto rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 font-mono text-[12.5px] leading-relaxed"
      style={{ maxHeight }}
    >
      <pre className="min-w-full">
        {lines.map((line, index) => {
          const parts: React.ReactNode[] = [];
          let lastIndex = 0;

          // `matchAll` clones the pattern internally, so the shared regex is
          // never mutated and no `lastIndex` reset is needed.
          for (const match of line.matchAll(TOKEN)) {
            if (match.index !== undefined && match.index > lastIndex) {
              parts.push(line.slice(lastIndex, match.index));
            }
            parts.push(
              <span key={`${index}-${match.index}`} className={tokenClass(match[0])}>
                {match[0]}
              </span>,
            );
            lastIndex = (match.index ?? 0) + match[0].length;
          }
          if (lastIndex < line.length) {
            parts.push(line.slice(lastIndex));
          }

          return (
            <div key={index} className="whitespace-pre">
              <span className="select-none pr-4 text-zinc-500">{String(index + 1).padStart(3, " ")}</span>
              {parts.length > 0 ? parts : " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
