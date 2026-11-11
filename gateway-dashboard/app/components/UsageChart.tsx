"use client";

import { useMemo } from "react";

type Point = { ts: number; success: number; failed: number };

type Props = {
  series: Point[];
  height?: number;
};

function pathFor(values: number[], max: number, width: number, height: number, pad: number): string {
  if (values.length === 0) return "";
  const innerWidth = width - pad * 2;
  const innerHeight = height - pad * 2;
  const step = values.length > 1 ? innerWidth / (values.length - 1) : 0;

  return values
    .map((value, index) => {
      const x = pad + step * index;
      const y = pad + innerHeight - (max > 0 ? (value / max) * innerHeight : 0);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function areaFor(values: number[], max: number, width: number, height: number, pad: number): string {
  const line = pathFor(values, max, width, height, pad);
  if (!line) return "";
  const innerWidth = width - pad * 2;
  const step = values.length > 1 ? innerWidth / (values.length - 1) : 0;
  const lastX = pad + step * (values.length - 1);
  const baseline = height - pad;
  return `${line} L${lastX.toFixed(1)},${baseline} L${pad},${baseline} Z`;
}

/**
 * Responsive SVG chart of successful runs against failed network requests.
 *
 * Hand rolled so the dashboard keeps a zero-dependency runtime footprint.
 */
export default function UsageChart({ series, height = 240 }: Props) {
  const width = 720;
  const pad = 36;

  const { successValues, failedValues, max, totalSuccess, totalFailed } = useMemo(() => {
    const success = series.map((point) => point.success);
    const failed = series.map((point) => point.failed);
    const highest = Math.max(1, ...success, ...failed);
    return {
      successValues: success,
      failedValues: failed,
      max: Math.ceil(highest / 2) * 2,
      totalSuccess: success.reduce((sum, value) => sum + value, 0),
      totalFailed: failed.reduce((sum, value) => sum + value, 0),
    };
  }, [series]);

  const gridLines = [0, 0.25, 0.5, 0.75, 1];
  const hasData = series.length > 0;

  return (
    <div className="w-full">
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-zinc-400">
        <span className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          Successful runs <span className="font-semibold text-emerald-300">{totalSuccess}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-rose-400" />
          Failed requests <span className="font-semibold text-rose-300">{totalFailed}</span>
        </span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label="Successful runs versus failed requests over time"
      >
        <defs>
          <linearGradient id="successFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#526c48" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#526c48" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridLines.map((ratio) => {
          const y = pad + (height - pad * 2) * (1 - ratio);
          return (
            <g key={ratio}>
              <line
                x1={pad}
                x2={width - pad}
                y1={y}
                y2={y}
                stroke="#d8d9d2"
                strokeDasharray="3 4"
              />
              <text x={pad - 10} y={y + 4} textAnchor="end" fontSize="11" fill="#747a70">
                {Math.round(max * ratio)}
              </text>
            </g>
          );
        })}

        {hasData ? (
          <>
            <path d={areaFor(successValues, max, width, height, pad)} fill="url(#successFill)" />
            <path
              d={pathFor(failedValues, max, width, height, pad)}
              fill="none"
              stroke="#b44c5a"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <path
              d={pathFor(successValues, max, width, height, pad)}
              fill="none"
              stroke="#526c48"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </>
        ) : (
          <text x={width / 2} y={height / 2} textAnchor="middle" fontSize="13" fill="#747a70">
            No requests recorded in this window yet.
          </text>
        )}
      </svg>
    </div>
  );
}
