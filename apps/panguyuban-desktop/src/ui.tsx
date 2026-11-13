import React from "react";

const ICONS = {
  home: "M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5z M6.5 13.5v-4h3v4",
  ticket: "M4 3.5h8A1.5 1.5 0 0 1 13.5 5v6a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 11V5A1.5 1.5 0 0 1 4 3.5z M5.5 6.5h5 M5.5 9.5h3",
  pr: "M4.5 5.5v5 M6 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z M6 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z M13 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z M11.5 10.5V7a2 2 0 0 0-2-2H8",
  agents: "M8 2.5l1.4 4.1 4.1 1.4-4.1 1.4L8 13.5l-1.4-4.1L2.5 8l4.1-1.4z",
  prototypes: "M4 2.5h8A1.5 1.5 0 0 1 13.5 4v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5z M2.5 6h11 M6.5 6v7.5",
  requests: "M3 5.5h9.5 M10 3l2.5 2.5L10 8 M13 10.5H3.5 M6 8l-2.5 2.5L6 13",
  settings: "M2.5 5h6 M11.5 5h2 M11.5 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z M2.5 11h2 M7.5 11h6 M7.5 11a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z",
  collapse: "M7.5 4l-4 4 4 4 M12.5 4l-4 4 4 4",
  expand: "M8.5 4l4 4-4 4 M3.5 4l4 4-4 4",
  refresh: "M13 8a5 5 0 1 1-1.5-3.5 M13.5 2.5V5H11",
  files: "M2.5 4h4L8 5.5h5.5V13h-11z",
  changes: "M8 3v5 M5.5 5.5h5 M5.5 11.5h5",
} as const;

export type IconName = keyof typeof ICONS;

/** 16px line icon in the current text colour. Decorative: label the button, not the icon. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Segmented filter above a list (replaces the old per-filter sidebar menu). */
export function FilterTabs<T extends string>(props: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; count: number }[];
}) {
  return (
    <div className="filter-tabs" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="filter-tab"
          aria-pressed={props.value === o.value}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
          <span className="measured">{o.count}</span>
        </button>
      ))}
    </div>
  );
}

type DiffFile = { path: string; lines: string[]; adds: number; dels: number };

/**
 * Splits a unified diff into one entry per file (at each `diff --git` header),
 * dropping the index/---/+++ header lines. A headerless diff is one "changes" file.
 */
function splitDiffByFile(lines: string[]): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let inHeader = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const path = line.split(" b/").pop() ?? line;
      current = { path, lines: [], adds: 0, dels: 0 };
      files.push(current);
      inHeader = true;
      continue;
    }
    if (!current) {
      current = { path: "changes", lines: [], adds: 0, dels: 0 };
      files.push(current);
    }
    if (inHeader && !line.startsWith("@@")) {
      // rename/binary/mode notes are worth keeping; index and ---/+++ are not
      if (/^(rename|Binary|new file|deleted file|similarity)/.test(line)) current.lines.push(line);
      continue;
    }
    inHeader = false;
    current.lines.push(line);
    if (line.startsWith("+")) current.adds++;
    else if (line.startsWith("-")) current.dels++;
  }
  return files;
}

/** A unified diff as one collapsible block per file, with +/− counts. */
export function DiffFiles({ lines }: { lines: string[] }) {
  return (
    <div className="diff-files">
      {splitDiffByFile(lines).map((file) => (
        <details key={file.path} className="diff-file" open>
          <summary className="diff-file-head">
            <span className="diff-file-path">{file.path}</span>
            <span className="diff-file-stat">
              <span className="diff-stat-plus">+{file.adds}</span>{" "}
              <span className="diff-stat-minus">−{file.dels}</span>
            </span>
          </summary>
          <div className="diff-panel" aria-label={`Diff of ${file.path}`}>
            {file.lines.map((line, idx) => (
              <div
                key={idx}
                className={
                  line.startsWith("@@")
                    ? "diff-line diff-line--hunk"
                    : line.startsWith("+")
                      ? "diff-line diff-line--plus"
                      : line.startsWith("-")
                        ? "diff-line diff-line--minus"
                        : "diff-line"
                }
              >
                {line}
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
