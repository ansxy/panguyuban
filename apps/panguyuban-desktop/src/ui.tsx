import React from "react";

export function padCount(count: number): string {
  return String(count).padStart(2, "0");
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
